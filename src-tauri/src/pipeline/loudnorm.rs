use std::path::Path;

use tauri::AppHandle;

use crate::domain::error::AppResult;
use crate::domain::media::Rational;
use crate::ffmpeg::sidecar::ffmpeg_stderr;
use crate::pipeline::timeline::Segment;

/// YouTube-standard loudness target.
pub const TARGET: &str = "I=-16:TP=-1.5:LRA=11";

/// Measured loudness stats from loudnorm pass 1 (`print_format=json`).
#[derive(Debug, Clone, PartialEq)]
pub struct LoudnormStats {
    pub input_i: String,
    pub input_tp: String,
    pub input_lra: String,
    pub input_thresh: String,
    pub target_offset: String,
}

/// Pass 1: measure loudness of the CUT audio timeline (not the raw file — the
/// cuts change integrated loudness). We build an AUDIO-ONLY trim+concat graph
/// and run it through loudnorm with `-f null`, so the cost is one analysis
/// pass, never a second video encode.
pub async fn measure_loudness(
    app: &AppHandle,
    input_path: &str,
    segments: &[Segment],
    fps: Rational,
    script_path: &Path,
) -> AppResult<Option<LoudnormStats>> {
    let graph = build_measure_graph(segments, fps, TARGET);
    tokio::fs::write(script_path, &graph).await?;
    let script = script_path.to_string_lossy();

    let stderr = ffmpeg_stderr(
        app,
        &[
            "-hide_banner",
            "-i", input_path,
            "-/filter_complex", &script,
            "-map", "[outa]",
            "-f", "null", "-",
        ],
    )
    .await?;

    Ok(parse_loudnorm_json(&stderr))
}

/// Audio-only trim+concat feeding loudnorm in measurement mode. Uses the same
/// per-segment second spans as the real encode graph (frame indices → seconds),
/// so what we measure matches what we later produce.
fn build_measure_graph(segments: &[Segment], fps: Rational, target: &str) -> String {
    let parts: Vec<String> = segments
        .iter()
        .enumerate()
        .map(|(i, seg)| {
            format!(
                "[0:a]atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS[a{i}]",
                seg.start_secs(fps),
                seg.end_secs(fps)
            )
        })
        .collect();
    let concat: String = (0..segments.len()).map(|i| format!("[a{i}]")).collect();
    format!(
        "{};{}concat=n={}:v=0:a=1,loudnorm={}:print_format=json[outa]",
        parts.join(";"),
        concat,
        segments.len(),
        target
    )
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
