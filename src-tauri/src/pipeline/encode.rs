use std::collections::VecDeque;
use std::process::Stdio;

use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::domain::error::{AppError, AppResult};
use crate::ffmpeg::provision::ffmpeg_path;
use crate::pipeline::output_plan::OutputPlan;

/// How the kept segments are fed to the encoder. Two strategies with identical
/// output settings, chosen by the orchestrator on segment count:
/// - `Concat`: a concat-demuxer script (`-f concat -safe 0 -i <script>`) that
///   seeks the source per segment. Fast at any cut count, but mis-cuts OPEN-GOP
///   HEVC (dropped video frames + inflated audio → A/V drift).
/// - `Filter`: a `filter_complex` graph that trims every segment off one
///   continuous decode (frame/sample accurate). Used below a segment threshold
///   because the fan-out only stays fast up to a few hundred cuts.
pub enum CutInput<'a> {
    Concat { script: &'a str, audio_filter: Option<&'a str> },
    Filter { input: &'a str, filter_complex: &'a str },
}

/// Assemble the ffmpeg argument list for the cut encode. CFR is forced (`-r
/// <rational> -fps_mode cfr`) so the joined output has one even frame grid; hvc1
/// tag and +faststart are applied only when the plan (ISO-BMFF) says so; the
/// muxer is set explicitly so a `.partial.<uuid>.<ext>` temp path still muxes
/// correctly. The input/mapping differs per [`CutInput`]: the concat path maps
/// `0:v:0`/`0:a:0` and applies its re-timing `audio_filter` via `-af`, while the
/// filter path maps the graph's `[v]`/`[a]` labels (loudnorm is already baked
/// into the graph, so no `-af`).
pub fn build_encode_args(
    plan: &OutputPlan,
    cut: &CutInput,
    output_path: &str,
    gop: u32,
) -> Vec<String> {
    let mut a: Vec<String> = vec!["-hide_banner".into()];
    match cut {
        CutInput::Concat { script, .. } => {
            a.extend(["-f".into(), "concat".into(), "-safe".into(), "0".into()]);
            a.push("-i".into());
            a.push((*script).into());
            a.push("-map".into());
            a.push("0:v:0".into());
            if plan.audio.is_some() {
                a.push("-map".into());
                a.push("0:a:0".into());
            }
        }
        CutInput::Filter { input, filter_complex } => {
            a.push("-i".into());
            a.push((*input).into());
            a.push("-filter_complex".into());
            a.push((*filter_complex).into());
            a.push("-map".into());
            a.push("[v]".into());
            if plan.audio.is_some() {
                a.push("-map".into());
                a.push("[a]".into());
            }
        }
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
        // The concat path re-times audio across the segment joins via -af; the
        // filter path already did its trimming (and loudnorm) inside the graph.
        if let CutInput::Concat { audio_filter: Some(af), .. } = cut {
            a.push("-af".into());
            a.push((*af).into());
        }
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

    fn concat<'a>(script: &'a str, af: Option<&'a str>) -> CutInput<'a> {
        CutInput::Concat { script, audio_filter: af }
    }

    #[test]
    fn args_have_concat_input_cfr_muxer_and_progress() {
        let a = build_encode_args(&plan(None, true, true), &concat("list.txt", Some("aresample=async=1")), "out.mp4", 60);
        let j = a.join(" ");
        assert!(j.contains("-f concat -safe 0 -i list.txt"));
        assert!(j.contains("-map 0:v:0"));
        assert!(j.contains("-map 0:a:0"));
        assert!(j.contains("-af aresample=async=1"));
        assert!(j.contains("-r 30000/1001 -fps_mode cfr"));
        assert!(j.contains("-f mp4"));
        assert!(j.contains("-progress pipe:1 -nostats"));
        assert!(j.contains("-movflags +faststart"));
    }

    #[test]
    fn filter_input_maps_graph_labels_and_omits_af() {
        let fc = "[0:v]trim=0:1,setpts=PTS-STARTPTS[v0];[0:a]atrim=0:1,asetpts=PTS-STARTPTS[a0];[v0][a0]concat=n=1:v=1:a=1[v][a]";
        let a = build_encode_args(&plan(None, true, true), &CutInput::Filter { input: "in.mp4", filter_complex: fc }, "out.mp4", 60);
        let j = a.join(" ");
        assert!(j.contains("-i in.mp4"));
        assert!(j.contains("-filter_complex"));
        assert!(j.contains("-map [v]"));
        assert!(j.contains("-map [a]"));
        assert!(!j.contains("-af")); // loudnorm/trim already in the graph
        assert!(!j.contains("-f concat"));
        assert!(j.contains("-r 30000/1001 -fps_mode cfr"));
    }

    #[test]
    fn hvc1_only_when_tagged() {
        let with = build_encode_args(&plan(Some("hvc1"), true, true), &concat("l", None), "o", 60).join(" ");
        assert!(with.contains("-tag:v hvc1"));
        let without = build_encode_args(&plan(None, true, true), &concat("l", None), "o", 60).join(" ");
        assert!(!without.contains("hvc1"));
    }

    #[test]
    fn no_audio_omits_audio_map_codec_and_filter() {
        let a = build_encode_args(&plan(None, false, false), &concat("l", Some("aresample=async=1")), "o", 60).join(" ");
        assert!(!a.contains("0:a:0"));
        assert!(!a.contains("-c:a"));
        assert!(!a.contains("-af"));
        assert!(!a.contains("+faststart"));
    }

    #[test]
    fn filter_no_audio_omits_audio_map() {
        let fc = "[0:v]trim=0:1,setpts=PTS-STARTPTS[v0];[v0]concat=n=1:v=1:a=0[v]";
        let a = build_encode_args(&plan(None, false, false), &CutInput::Filter { input: "in.mp4", filter_complex: fc }, "o", 60).join(" ");
        assert!(a.contains("-map [v]"));
        assert!(!a.contains("-map [a]"));
        assert!(!a.contains("-c:a"));
    }

    #[test]
    fn progress_parses_out_time_us() {
        assert_eq!(parse_progress("out_time_us=30000000", 60.0), Some(0.5));
        assert_eq!(parse_progress("out_time_us=120000000", 60.0), Some(0.99)); // capped
        assert_eq!(parse_progress("progress=continue", 60.0), None);
    }
}
