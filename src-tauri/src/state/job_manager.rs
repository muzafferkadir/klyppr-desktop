use std::sync::Mutex;

use tokio_util::sync::CancellationToken;

use crate::domain::job::JobId;

struct ActiveJob {
    id: JobId,
    token: CancellationToken,
}

/// Tracks the single in-flight job. Uses a std Mutex held only for the tiny
/// critical sections below — never across an await — so the pipeline task can
/// run freely while the lock is free.
#[derive(Default)]
pub struct JobManager {
    active: Mutex<Option<ActiveJob>>,
}

impl JobManager {
    /// Claim the slot for `id`. Returns a fresh cancellation token, or `None`
    /// if a job is already running (caller reports "busy").
    pub fn try_start(&self, id: JobId) -> Option<CancellationToken> {
        let mut slot = self.active.lock().unwrap();
        if slot.is_some() {
            return None;
        }
        let token = CancellationToken::new();
        *slot = Some(ActiveJob { id, token: token.clone() });
        Some(token)
    }

    /// Cancel the active job iff its id matches. Returns whether anything was
    /// cancelled (a stale/unknown id is a no-op → false).
    pub fn cancel(&self, id: &JobId) -> bool {
        let slot = self.active.lock().unwrap();
        match &*slot {
            Some(a) if &a.id == id => {
                a.token.cancel();
                true
            }
            _ => false,
        }
    }

    /// Release the slot, but only if `id` still owns it — a finishing job must
    /// not clear a newer job that took the slot after it.
    pub fn finish(&self, id: &JobId) {
        let mut slot = self.active.lock().unwrap();
        if matches!(&*slot, Some(a) if &a.id == id) {
            *slot = None;
        }
    }

    #[allow(dead_code)] // used by UI busy-state queries / tests
    pub fn is_busy(&self) -> bool {
        self.active.lock().unwrap().is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_job_at_a_time() {
        let m = JobManager::default();
        let a = JobId("a".into());
        let b = JobId("b".into());
        assert!(m.try_start(a.clone()).is_some());
        assert!(m.try_start(b.clone()).is_none(), "second job must be rejected");
        assert!(m.is_busy());
    }

    #[test]
    fn cancel_only_matching_id() {
        let m = JobManager::default();
        let a = JobId("a".into());
        let token = m.try_start(a.clone()).unwrap();
        assert!(!m.cancel(&JobId("other".into())));
        assert!(!token.is_cancelled());
        assert!(m.cancel(&a));
        assert!(token.is_cancelled());
    }

    #[test]
    fn finish_wont_clear_a_newer_job() {
        let m = JobManager::default();
        let a = JobId("a".into());
        m.try_start(a.clone()).unwrap();
        m.finish(&a);
        assert!(!m.is_busy());
        // A stale finish for a no longer must not clear b.
        let b = JobId("b".into());
        m.try_start(b).unwrap();
        m.finish(&a);
        assert!(m.is_busy());
    }
}
