use crate::domain::media::Rational;
use crate::pipeline::silence::SilenceRange;

/// Shortest talking span we bother keeping, in seconds.
pub const MIN_SEGMENT_SECS: f64 = 0.05;

/// A kept span of speech, addressed in whole frames so the trimmed VIDEO and
/// AUDIO share the exact same length — the audio atrim and video trim are both
/// derived from these frame indices, not from a decimal time, which is what
/// prevents per-segment A/V drift from accumulating across cuts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Segment {
    pub start_frame: u64,
    pub end_frame: u64,
}

impl Segment {
    pub fn frame_count(&self) -> u64 {
        self.end_frame - self.start_frame
    }

    pub fn start_secs(&self, fps: Rational) -> f64 {
        self.start_frame as f64 * fps.den as f64 / fps.num as f64
    }

    pub fn end_secs(&self, fps: Rational) -> f64 {
        self.end_frame as f64 * fps.den as f64 / fps.num as f64
    }
}

/// Turn raw silence spans into the speech segments to keep. Order matters:
/// pad → merge overlaps → complement → filter tiny → frame-snap → drop zero
/// frame. Snapping is full-precision `round(t*fps)` (never toFixed), so NTSC
/// rates don't round a frame off and reintroduce drift.
pub fn build_timeline(
    silences: &[SilenceRange],
    duration: f64,
    padding: f64,
    fps: Rational,
) -> Vec<Segment> {
    // Pad each silence inward (keep a little speech around the cut), dropping
    // spans that collapse to nothing once padded.
    let mut padded: Vec<SilenceRange> = silences
        .iter()
        .map(|s| SilenceRange {
            start: s.start + padding,
            end: s.end - padding,
        })
        .filter(|s| s.end - s.start > MIN_SEGMENT_SECS)
        .collect();

    padded.sort_by(|a, b| a.start.total_cmp(&b.start));
    let merged = merge_overlaps(padded);

    // Complement: speech is everything between the silences.
    let talking = complement(&merged, duration);

    let fps_f = fps.as_f64();
    talking
        .into_iter()
        .filter(|(s, e)| e - s > MIN_SEGMENT_SECS)
        .filter_map(|(s, e)| {
            let start_frame = (s * fps_f).round() as u64;
            let end_frame = (e * fps_f).round() as u64;
            (end_frame > start_frame).then_some(Segment { start_frame, end_frame })
        })
        .collect()
}

fn merge_overlaps(sorted: Vec<SilenceRange>) -> Vec<SilenceRange> {
    let mut out: Vec<SilenceRange> = Vec::new();
    for s in sorted {
        match out.last_mut() {
            Some(last) if s.start <= last.end => last.end = last.end.max(s.end),
            _ => out.push(s),
        }
    }
    out
}

/// Gaps between silences (and the head/tail), clamped to [0, duration].
fn complement(silences: &[SilenceRange], duration: f64) -> Vec<(f64, f64)> {
    let mut talking = Vec::new();
    let mut cursor = 0.0_f64;
    for s in silences {
        // Clamp to [0, duration] so a silence that runs past the end can't push
        // a talking span past duration and inflate the expected output length.
        let start = s.start.clamp(0.0, duration);
        if start > cursor {
            talking.push((cursor, start));
        }
        cursor = cursor.max(s.end).min(duration);
    }
    if cursor < duration {
        talking.push((cursor, duration));
    }
    talking
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fps30() -> Rational {
        Rational { num: 30, den: 1 }
    }

    #[test]
    fn complement_between_silences() {
        // 10s clip, one silence 3-5 → keep 0-3 and 5-10.
        let sil = [SilenceRange { start: 3.0, end: 5.0 }];
        let segs = build_timeline(&sil, 10.0, 0.0, fps30());
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0], Segment { start_frame: 0, end_frame: 90 });
        assert_eq!(segs[1], Segment { start_frame: 150, end_frame: 300 });
    }

    #[test]
    fn no_silence_keeps_whole_clip() {
        let segs = build_timeline(&[], 4.0, 0.0, fps30());
        assert_eq!(segs, vec![Segment { start_frame: 0, end_frame: 120 }]);
    }

    #[test]
    fn merges_overlapping_padded_silences() {
        // Two silences that touch/overlap after padding collapse into one gap.
        // padded: [2.05,3.95] and [3.95,5.95] → merge → [2.05,5.95].
        let sil = [
            SilenceRange { start: 2.0, end: 4.0 },
            SilenceRange { start: 3.9, end: 6.0 },
        ];
        let segs = build_timeline(&sil, 8.0, 0.05, fps30());
        // keep: 0..~2.05, then ~5.95..8  → two segments
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].start_frame, 0);
    }

    #[test]
    fn drops_tiny_and_zero_frame_segments() {
        // A 0.01s gap (< MIN_SEGMENT and < 1 frame) is dropped.
        let sil = [
            SilenceRange { start: 0.0, end: 3.0 },
            SilenceRange { start: 3.01, end: 6.0 },
        ];
        let segs = build_timeline(&sil, 6.0, 0.0, fps30());
        assert!(segs.is_empty());
    }
}
