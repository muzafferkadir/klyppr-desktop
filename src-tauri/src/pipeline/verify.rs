use std::path::Path;

use serde_json::Value;
use tauri::AppHandle;

use crate::domain::error::{AppError, AppResult};
use crate::ffmpeg::sidecar::ffprobe;
use crate::pipeline::output_plan::OutputPlan;

/// Probe the produced file and assert it matches the plan: duration is close to
/// what the cuts predicted, HEVC/ISO-BMFF outputs carry the `hvc1` tag, and the
/// video/audio stream durations agree within a small tolerance (no drift). A
/// failure here means we do NOT publish the file (the caller keeps the .partial
/// and errors), so a broken encode never lands on the user's real output path.
pub async fn verify_output(
    app: &AppHandle,
    output_path: &str,
    plan: &OutputPlan,
    expected_duration: f64,
) -> AppResult<()> {
    let json = ffprobe(
        app,
        &[
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            output_path,
        ],
    )
    .await?;
    let root: Value = serde_json::from_str(&json)
        .map_err(|e| AppError::OutputVerify(format!("unreadable output: {e}")))?;
    check(&root, plan, expected_duration)
}

/// Pure check over parsed ffprobe JSON — unit tested.
fn check(root: &Value, plan: &OutputPlan, expected_duration: f64) -> AppResult<()> {
    let empty = Vec::new();
    let streams = root.get("streams").and_then(Value::as_array).unwrap_or(&empty);

    let video = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(Value::as_str) == Some("video"));
    let audio = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(Value::as_str) == Some("audio"));

    let video = video.ok_or_else(|| AppError::OutputVerify("output has no video stream".into()))?;

    // The plan expected audio but the output has none — a silent file must not
    // be published as success.
    if plan.audio.is_some() && audio.is_none() {
        return Err(AppError::OutputVerify(
            "expected an audio stream but output has none".into(),
        ));
    }

    // Container duration close to what the cuts predicted (2% + 1s slack).
    let dur = root
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(Value::as_str)
        .and_then(|d| d.parse::<f64>().ok())
        .ok_or_else(|| AppError::OutputVerify("output has no duration".into()))?;
    let dur_tol = expected_duration * 0.02 + 1.0;
    if (dur - expected_duration).abs() > dur_tol {
        return Err(AppError::OutputVerify(format!(
            "duration {dur:.2}s off expected {expected_duration:.2}s (tol {dur_tol:.2}s)"
        )));
    }

    // HEVC in ISO-BMFF must be tagged hvc1 or Apple players show a black screen.
    if plan.video_tag == Some("hvc1") {
        let tag = video
            .get("codec_tag_string")
            .and_then(Value::as_str)
            .unwrap_or("");
        if tag != "hvc1" {
            return Err(AppError::OutputVerify(format!(
                "expected hvc1 tag, got '{tag}'"
            )));
        }
    }

    // A/V stream durations agree (drift guard): within ~2 frames + a margin.
    if let Some(audio) = audio {
        let vd = stream_duration(video);
        let ad = stream_duration(audio);
        if let (Some(vd), Some(ad)) = (vd, ad) {
            if (vd - ad).abs() > 0.1 {
                return Err(AppError::OutputVerify(format!(
                    "A/V drift: video {vd:.3}s vs audio {ad:.3}s"
                )));
            }
        }
    }

    Ok(())
}

fn stream_duration(s: &Value) -> Option<f64> {
    s.get("duration")
        .and_then(Value::as_str)
        .and_then(|d| d.parse::<f64>().ok())
}

/// Publish the finished file: rename the verified .partial onto the real output
/// path. Same-directory rename so it's atomic on one filesystem.
pub async fn publish(partial: &Path, final_path: &Path) -> AppResult<()> {
    tokio::fs::rename(partial, final_path).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::media::Rational;
    use crate::pipeline::output_plan::{Container, OutputPlan, VideoEncodePlan};

    fn plan(tag: Option<&'static str>) -> OutputPlan {
        OutputPlan {
            container: Container::Mp4,
            output_ext: "mp4".into(),
            muxer: "mp4",
            cfr_fps: Rational { num: 30, den: 1 },
            video: VideoEncodePlan {
                encoder: "libx264".into(),
                is_hardware: false,
                pix_fmt: "yuv420p".into(),
                quality_args: vec![],
            },
            audio: None,
            video_tag: tag,
            faststart: true,
        }
    }

    fn json(dur: f64, vdur: f64, adur: Option<f64>, tag: &str) -> Value {
        let mut streams = vec![serde_json::json!({
            "codec_type": "video",
            "codec_tag_string": tag,
            "duration": vdur.to_string(),
        })];
        if let Some(ad) = adur {
            streams.push(serde_json::json!({
                "codec_type": "audio",
                "duration": ad.to_string(),
            }));
        }
        serde_json::json!({ "format": { "duration": dur.to_string() }, "streams": streams })
    }

    #[test]
    fn passes_when_duration_and_sync_ok() {
        let v = json(30.0, 30.0, Some(30.02), "avc1");
        assert!(check(&v, &plan(None), 30.0).is_ok());
    }

    #[test]
    fn fails_on_duration_far_off() {
        let v = json(20.0, 20.0, None, "avc1");
        assert!(check(&v, &plan(None), 30.0).is_err());
    }

    #[test]
    fn fails_on_missing_hvc1_tag() {
        let v = json(30.0, 30.0, None, "hev1");
        assert!(check(&v, &plan(Some("hvc1")), 30.0).is_err());
    }

    #[test]
    fn passes_with_hvc1_tag() {
        let v = json(30.0, 30.0, None, "hvc1");
        assert!(check(&v, &plan(Some("hvc1")), 30.0).is_ok());
    }

    #[test]
    fn fails_on_av_drift() {
        let v = json(30.0, 30.0, Some(29.5), "avc1");
        assert!(check(&v, &plan(None), 30.0).is_err());
    }

    #[test]
    fn fails_when_audio_expected_but_missing() {
        let mut p = plan(None);
        p.audio = Some(crate::pipeline::output_plan::AudioEncodePlan {
            encoder: "aac".into(),
            bitrate: "256k".into(),
            resample_hz: None,
        });
        let v = json(30.0, 30.0, None, "avc1"); // no audio stream
        assert!(check(&v, &p, 30.0).is_err());
    }
}
