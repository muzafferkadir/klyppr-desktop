use std::collections::VecDeque;
use std::process::Stdio;

use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::domain::error::{AppError, AppResult};
use crate::ffmpeg::provision::ffmpeg_path;
use crate::pipeline::output_plan::OutputPlan;

/// Assemble the ffmpeg argument list for the cut+concat encode. CFR is forced
/// (`-r <rational> -fps_mode cfr`) so the concatenated output has one even frame
/// grid; hvc1 tag and +faststart are applied only when the plan (ISO-BMFF) says
/// so; the muxer is set explicitly so a `.partial.<uuid>.<ext>` temp path still
/// muxes correctly.
pub fn build_encode_args(
    plan: &OutputPlan,
    input_path: &str,
    script_path: &str,
    output_path: &str,
    gop: u32,
) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-hide_banner".into(),
        "-i".into(), input_path.into(),
        "-/filter_complex".into(), script_path.into(),
        "-map".into(), "[outv]".into(),
    ];
    if plan.audio.is_some() {
        a.push("-map".into());
        a.push("[outa]".into());
    }
    a.push("-map_metadata".into());
    a.push("0".into());

    a.push("-c:v".into());
    a.push(plan.video.encoder.clone());
    a.extend(plan.video.quality_args.iter().cloned());
    a.push("-pix_fmt".into());
    a.push(plan.video.pix_fmt.clone());
    a.push("-r".into());
    a.push(plan.cfr_fps.as_ffmpeg());
    a.push("-fps_mode".into());
    a.push("cfr".into());
    a.push("-g".into());
    a.push(gop.to_string());

    if let Some(tag) = plan.video_tag {
        a.push("-tag:v".into());
        a.push(tag.into());
    }

    if let Some(audio) = &plan.audio {
        a.push("-c:a".into());
        a.push(audio.encoder.clone());
        a.push("-b:a".into());
        a.push(audio.bitrate.clone());
    }

    a.push("-avoid_negative_ts".into());
    a.push("make_zero".into());
    if plan.faststart {
        a.push("-movflags".into());
        a.push("+faststart".into());
    }
    a.push("-f".into());
    a.push(plan.muxer.into());
    a.push("-progress".into());
    a.push("pipe:1".into());
    a.push("-nostats".into());
    a.push("-threads".into());
    a.push("0".into());
    a.push("-y".into());
    a.push(output_path.into());
    a
}

/// Fraction [0,1) parsed from an ffmpeg `-progress pipe:1` stdout line
/// (`out_time_us=1234567`). Capped at 0.99 so completion is signalled by
/// Terminated, not progress.
pub fn parse_progress(line: &str, expected_duration: f64) -> Option<f64> {
    let us: f64 = line.strip_prefix("out_time_us=")?.trim().parse().ok()?;
    if expected_duration <= 0.0 {
        return None;
    }
    let frac = (us / 1_000_000.0) / expected_duration;
    Some(frac.clamp(0.0, 0.99))
}

/// Run the encode, streaming progress (stdout) and logs (stderr). Cancelling
/// the token kills the child and drains to its Terminated event before
/// returning `Cancelled`, so no zombie is left holding the output file.
pub async fn run_encode(
    app: &AppHandle,
    args: Vec<String>,
    expected_duration: f64,
    token: &CancellationToken,
    on_progress: &(dyn Fn(f64) + Send + Sync),
    on_log: &(dyn Fn(&str) + Send + Sync),
) -> AppResult<()> {
    let mut child = Command::new(ffmpeg_path(app)?)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::SidecarSpawn(format!("ffmpeg: {e}")))?;

    let mut out = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut err = BufReader::new(child.stderr.take().unwrap()).lines();
    let mut out_open = true;
    let mut err_open = true;
    let mut tail: VecDeque<String> = VecDeque::with_capacity(4);

    // Read stdout (progress) and stderr (logs) until both pipes close, then reap.
    loop {
        tokio::select! {
            _ = token.cancelled() => {
                let _ = child.kill().await;
                return Err(AppError::Cancelled);
            }
            line = out.next_line(), if out_open => match line {
                Ok(Some(l)) => {
                    if let Some(frac) = parse_progress(l.trim(), expected_duration) {
                        on_progress(frac);
                    }
                }
                _ => out_open = false,
            },
            line = err.next_line(), if err_open => match line {
                Ok(Some(l)) => {
                    let l = l.trim().to_string();
                    if !l.is_empty() {
                        if tail.len() == 3 {
                            tail.pop_front();
                        }
                        tail.push_back(l.clone());
                        on_log(&l);
                    }
                }
                _ => err_open = false,
            },
        }
        if !out_open && !err_open {
            break;
        }
    }

    let status = child.wait().await.map_err(|e| AppError::Io(e.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(AppError::FfmpegExit {
            code: status.code(),
            stderr_tail: tail.iter().cloned().collect::<Vec<_>>().join(" | "),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::media::Rational;
    use crate::pipeline::output_plan::{AudioEncodePlan, Container, OutputPlan, VideoEncodePlan};

    fn plan(tag: Option<&'static str>, faststart: bool, audio: bool) -> OutputPlan {
        OutputPlan {
            container: Container::Mp4,
            output_ext: "mp4".into(),
            muxer: "mp4",
            cfr_fps: Rational { num: 30000, den: 1001 },
            video: VideoEncodePlan {
                encoder: "libx264".into(),
                is_hardware: false,
                pix_fmt: "yuv420p".into(),
                quality_args: vec!["-preset".into(), "veryfast".into(), "-crf".into(), "23".into()],
            },
            audio: audio.then(|| AudioEncodePlan {
                encoder: "aac".into(),
                bitrate: "256k".into(),
                resample_hz: None,
            }),
            video_tag: tag,
            faststart,
        }
    }

    #[test]
    fn args_have_cfr_and_muxer_and_progress() {
        let a = build_encode_args(&plan(None, true, true), "in.mp4", "s.txt", "out.mp4", 60);
        let j = a.join(" ");
        assert!(j.contains("-r 30000/1001 -fps_mode cfr"));
        assert!(j.contains("-f mp4"));
        assert!(j.contains("-progress pipe:1 -nostats"));
        assert!(j.contains("-movflags +faststart"));
        assert!(j.contains("-map [outa]"));
    }

    #[test]
    fn hvc1_only_when_tagged() {
        let with = build_encode_args(&plan(Some("hvc1"), true, true), "i", "s", "o", 60).join(" ");
        assert!(with.contains("-tag:v hvc1"));
        let without = build_encode_args(&plan(None, true, true), "i", "s", "o", 60).join(" ");
        assert!(!without.contains("hvc1"));
    }

    #[test]
    fn no_audio_omits_audio_map_and_codec() {
        let a = build_encode_args(&plan(None, false, false), "i", "s", "o", 60).join(" ");
        assert!(!a.contains("[outa]"));
        assert!(!a.contains("-c:a"));
        assert!(!a.contains("+faststart"));
    }

    #[test]
    fn progress_parses_out_time_us() {
        assert_eq!(parse_progress("out_time_us=30000000", 60.0), Some(0.5));
        assert_eq!(parse_progress("out_time_us=120000000", 60.0), Some(0.99)); // capped
        assert_eq!(parse_progress("progress=continue", 60.0), None);
    }
}
