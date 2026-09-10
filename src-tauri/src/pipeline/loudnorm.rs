use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use crate::domain::error::AppResult;
use crate::ffmpeg::sidecar::ffmpeg_stderr_progress;

/// YouTube-standard loudness target.
pub const TARGET: &str = "I=-16:TP=-1.5:LRA=11";

/// Discard sink for the measurement pass — progress rides `pipe:1`, so the null
/// muxer output must go somewhere other than stdout.
#[cfg(windows)]
const NULL_SINK: &str = "NUL";
#[cfg(not(windows))]
const NULL_SINK: &str = "/dev/null";

/// Measured loudness stats from loudnorm pass 1 (`print_format=json`).
#[derive(Debug, Clone, PartialEq)]
pub struct LoudnormStats {
    pub input_i: String,
    pub input_tp: String,
    pub input_lra: String,
    pub input_thresh: String,
    pub target_offset: String,
}

/// Pass 1: measure loudness over the FULL input audio (single `-af loudnorm`
/// pass with `-f null`). We deliberately do NOT rebuild the cut timeline here:
/// a 600+ segment `atrim`/`concat` graph is pathologically slow (minutes of
/// 100% CPU), while loudnorm's own EBU R128 gating already discards the
/// near-silent regions we cut, so the measured integrated loudness is within a
/// few tenths of a LU of the cut version — well inside broadcast tolerance and
/// inaudible. True peak is identical (peaks live in the kept, loud regions).
pub async fn measure_loudness(
    app: &AppHandle,
    input_path: &str,
    total_duration: f64,
    token: &CancellationToken,
    on_progress: &(dyn Fn(f64) + Send + Sync),
) -> AppResult<Option<LoudnormStats>> {
    let af = format!("loudnorm={TARGET}:print_format=json");
    let stderr = ffmpeg_stderr_progress(
        app,
        &[
            "-hide_banner",
            "-vn",
            "-i", input_path,
            "-map", "0:a:0",
            "-af", &af,
            "-f", "null",
            "-progress", "pipe:1",
            "-nostats",
            NULL_SINK,
        ],
        total_duration,
        token,
        on_progress,
    )
    .await?;

    Ok(parse_loudnorm_json(&stderr))
}

/// Build the pass-2 loudnorm filter. With stats → linear (two-pass) mode; without
/// → single-pass. Always appends `aresample` back to the source rate when known,
/// because loudnorm internally upsamples to 192 kHz and would otherwise leave the
/// output at 192 kHz.
pub fn build_loudnorm_filter(stats: Option<&LoudnormStats>, resample_hz: Option<u32>) -> String {
    let mut f = match stats {
        Some(s) => format!(
            "loudnorm={TARGET}:measured_I={}:measured_TP={}:measured_LRA={}:measured_thresh={}:offset={}:linear=true",
            s.input_i, s.input_tp, s.input_lra, s.input_thresh, s.target_offset
        ),
        None => format!("loudnorm={TARGET}"),
    };
    if let Some(hz) = resample_hz {
        f.push_str(&format!(",aresample={hz}"));
    }
    f
}

/// Extract the last JSON object loudnorm prints to stderr.
pub fn parse_loudnorm_json(stderr: &str) -> Option<LoudnormStats> {
    let open = stderr.rfind('{')?;
    let close = stderr.rfind('}')?;
    if close <= open {
        return None;
    }
    let json: serde_json::Value = serde_json::from_str(&stderr[open..=close]).ok()?;
    let get = |k: &str| json.get(k).and_then(|v| v.as_str()).map(str::to_string);
    let input_i = get("input_i")?;

    // Near-silent / empty audio measures as -inf (or absurdly low). Two-pass
    // linear mode with that measurement produces broken gain, so treat it as
    // "no usable measurement" and fall back to single-pass.
    match input_i.parse::<f64>() {
        Ok(v) if v.is_finite() && v > -70.0 => {}
        _ => return None,
    }

    Some(LoudnormStats {
        input_i,
        input_tp: get("input_tp")?,
        input_lra: get("input_lra")?,
        input_thresh: get("input_thresh")?,
        target_offset: get("target_offset")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_two_pass_with_resample() {
        let s = LoudnormStats {
            input_i: "-19.0".into(),
            input_tp: "-2.0".into(),
            input_lra: "7.0".into(),
            input_thresh: "-30.0".into(),
            target_offset: "0.5".into(),
        };
        let f = build_loudnorm_filter(Some(&s), Some(48000));
        assert!(f.contains("measured_I=-19.0"));
        assert!(f.contains("linear=true"));
        assert!(f.ends_with(",aresample=48000"));
    }

    #[test]
    fn filter_single_pass_without_stats() {
        let f = build_loudnorm_filter(None, Some(44100));
        assert_eq!(f, "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100");
    }

    #[test]
    fn parses_last_json_block() {
        let stderr = "noise\n{\n  \"input_i\": \"-19.0\",\n  \"input_tp\": \"-2.0\",\n  \"input_lra\": \"7.0\",\n  \"input_thresh\": \"-30.0\",\n  \"target_offset\": \"0.5\"\n}\n";
        let s = parse_loudnorm_json(stderr).unwrap();
        assert_eq!(s.input_i, "-19.0");
        assert_eq!(s.target_offset, "0.5");
    }

    #[test]
    fn rejects_silent_input_measurement() {
        let stderr = "{\n  \"input_i\": \"-inf\",\n  \"input_tp\": \"-inf\",\n  \"input_lra\": \"0.0\",\n  \"input_thresh\": \"-inf\",\n  \"target_offset\": \"0.0\"\n}";
        assert!(parse_loudnorm_json(stderr).is_none());
    }
}
