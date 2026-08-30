use std::collections::VecDeque;

use tauri::AppHandle;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio_util::sync::CancellationToken;

use crate::domain::error::{AppError, AppResult};
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
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let (mut rx, child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| AppError::SidecarMissing(format!("ffmpeg: {e}")))?
        .args(arg_refs)
        .spawn()
        .map_err(|e| AppError::SidecarSpawn(format!("ffmpeg: {e}")))?;

    let mut child = Some(child);
    let mut tail: VecDeque<String> = VecDeque::with_capacity(4);

    loop {
        tokio::select! {
            _ = token.cancelled() => {
                if let Some(c) = child.take() {
                    let _ = c.kill();
                }
                // Drain to the process's exit so it's fully reaped.
                while let Some(ev) = rx.recv().await {
                    if matches!(ev, CommandEvent::Terminated(_)) {
                        break;
                    }
                }
                return Err(AppError::Cancelled);
            }
            event = rx.recv() => match event {
                Some(CommandEvent::Stdout(bytes)) => {
                    let line = String::from_utf8_lossy(&bytes);
                    if let Some(frac) = parse_progress(line.trim(), expected_duration) {
                        on_progress(frac);
                    }
                }
                Some(CommandEvent::Stderr(bytes)) => {
                    let line = String::from_utf8_lossy(&bytes).trim().to_string();
                    if !line.is_empty() {
                        if tail.len() == 3 {
                            tail.pop_front();
                        }
                        tail.push_back(line.clone());
                        on_log(&line);
                    }
                }
                Some(CommandEvent::Terminated(payload)) => {
                    return if payload.code == Some(0) {
                        Ok(())
                    } else {
                        Err(AppError::FfmpegExit {
                            code: payload.code,
                            stderr_tail: tail.iter().cloned().collect::<Vec<_>>().join(" | "),
                        })
                    };
                }
                Some(_) => {}
                None => {
                    return Err(AppError::FfmpegExit {
                        code: None,
                        stderr_tail: "ffmpeg stream closed without a termination event".into(),
                    });
                }
            }
        }
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
