use serde::{Deserialize, Serialize};

use super::error::AppErrorDto;

/// Opaque job handle. Every event carries it so the frontend can route
/// progress even if we later allow more than one job.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct JobId(pub String);

impl JobId {
    pub fn new() -> Self {
        JobId(uuid::Uuid::new_v4().to_string())
    }
}

impl Default for JobId {
    fn default() -> Self {
        Self::new()
    }
}

/// Coarse pipeline phase, for the UI status line.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Probe,
    Detect,
    Measure,
    Encode,
    Verify,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

/// The single event type emitted to the frontend (`serde` tagged union →
/// TS discriminated union). One channel, one shape.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JobEvent {
    Phase { job_id: JobId, phase: Phase },
    Progress { job_id: JobId, fraction: f64 },
    Log { job_id: JobId, level: LogLevel, message: String },
    Finished { job_id: JobId, output_path: String },
    Failed { job_id: JobId, error: AppErrorDto },
    Cancelled { job_id: JobId },
}

/// Quality knob — maps to CRF/CQ later in the encode stage.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QualityPreset {
    Fast,
    Medium,
    High,
    Lossless,
}

/// What the frontend asks to run. Kept flat and serde-friendly.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    pub input_path: String,
    pub output_dir: String,
    /// silencedetect noise floor in dB (negative, e.g. -30).
    pub silence_db: f64,
    /// minimum silence duration to cut, seconds.
    pub min_silence: f64,
    /// padding kept around speech at each cut, seconds.
    pub padding: f64,
    pub normalize_audio: bool,
    pub quality: QualityPreset,
    pub use_hardware: bool,
}
