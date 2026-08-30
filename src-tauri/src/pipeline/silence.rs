use tauri::AppHandle;

use crate::domain::error::AppResult;
use crate::ffmpeg::sidecar::ffmpeg_stderr;

/// A detected silent span in the source, in seconds (raw — before padding).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SilenceRange {
    pub start: f64,
    pub end: f64,
}

/// Run ffmpeg's silencedetect over the audio only (`-vn`, fast) and parse the
/// stderr log into silent spans. A trailing `silence_start` with no matching
/// `silence_end` (video ends in silence) is closed at `duration` so the tail
/// silence is still removable.
pub async fn detect_silence(
    app: &AppHandle,
    input_path: &str,
    silence_db: f64,
    min_silence: f64,
    duration: f64,
) -> AppResult<Vec<SilenceRange>> {
    let filter = format!("silencedetect=noise={silence_db}dB:d={min_silence}");
    let stderr = ffmpeg_stderr(
        app,
        &["-hide_banner", "-vn", "-i", input_path, "-af", &filter, "-f", "null", "-"],
    )
    .await?;

    Ok(parse_silence(&stderr, duration))
}

/// Parse silencedetect stderr lines into ranges. Pure — unit tested.
pub fn parse_silence(stderr: &str, duration: f64) -> Vec<SilenceRange> {
    let mut ranges = Vec::new();
    let mut open_start: Option<f64> = None;

    for line in stderr.lines() {
        if let Some(v) = after(line, "silence_start:") {
            open_start = Some(v);
        } else if let Some(end) = after(line, "silence_end:") {
            if let Some(start) = open_start.take() {
                ranges.push(SilenceRange { start, end });
            }
        }
    }

    // Video ends in silence: silence_start with no silence_end → close at EOF.
    if let Some(start) = open_start {
        if duration > start {
            ranges.push(SilenceRange { start, end: duration });
        }
    }

    ranges
}

/// Extract the first float following `marker` on a line (silencedetect logs
/// `silence_end: 15.67 | silence_duration: 3.3`).
fn after(line: &str, marker: &str) -> Option<f64> {
    let rest = line.split_once(marker)?.1.trim_start();
    let token: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();
    token.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_paired_ranges() {
        let log = "\
[silencedetect @ 0x1] silence_start: 1.5
[silencedetect @ 0x1] silence_end: 3.0 | silence_duration: 1.5
[silencedetect @ 0x1] silence_start: 8.25
[silencedetect @ 0x1] silence_end: 9.1 | silence_duration: 0.85";
        let r = parse_silence(log, 20.0);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0], SilenceRange { start: 1.5, end: 3.0 });
        assert_eq!(r[1], SilenceRange { start: 8.25, end: 9.1 });
    }

    #[test]
    fn closes_trailing_silence_at_duration() {
        let log = "[silencedetect @ 0x1] silence_start: 18.0";
        let r = parse_silence(log, 20.0);
        assert_eq!(r, vec![SilenceRange { start: 18.0, end: 20.0 }]);
    }

    #[test]
    fn ignores_trailing_start_past_duration() {
        let log = "silence_start: 25.0";
        assert!(parse_silence(log, 20.0).is_empty());
    }
}
