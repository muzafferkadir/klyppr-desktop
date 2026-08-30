use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use crate::domain::error::{AppError, AppResult};
use crate::domain::job::{JobEvent, JobId, JobRequest, LogLevel, Phase};
use crate::pipeline::output_plan::{
    resolve_output_plan, EncoderAvailability, HwEncoder, OutputPlan,
};
use crate::pipeline::{encode, filtergraph, loudnorm, probe, silence, timeline, verify};

const TEMP_ROOT: &str = ".klyppr_temp";
const EVENT: &str = "job-event";

fn emit(app: &AppHandle, ev: JobEvent) {
    let _ = app.emit(EVENT, ev);
}

fn phase(app: &AppHandle, id: &JobId, p: Phase) {
    emit(app, JobEvent::Phase { job_id: id.clone(), phase: p });
}

fn log(app: &AppHandle, id: &JobId, level: LogLevel, message: impl Into<String>) {
    emit(app, JobEvent::Log { job_id: id.clone(), level, message: message.into() });
}

fn bail_if_cancelled(token: &CancellationToken) -> AppResult<()> {
    if token.is_cancelled() {
        Err(AppError::Cancelled)
    } else {
        Ok(())
    }
}

/// Run the whole pipeline for one job. Emits Phase/Log/Progress events; the
/// caller emits the terminal Finished/Failed/Cancelled. Returns the published
/// output path on success. All temp/partial files are cleaned up on the way out.
pub async fn run_pipeline(
    app: &AppHandle,
    request: &JobRequest,
    job_id: &JobId,
    token: &CancellationToken,
    hw: Option<HwEncoder>,
) -> AppResult<String> {
    validate(request)?;
    bail_if_cancelled(token)?;

    let output_path = build_output_path(&request.output_dir, &request.input_path);
    if same_file(&request.input_path, &output_path) {
        return Err(AppError::InputValidation(
            "input and output resolve to the same file".into(),
        ));
    }

    // Sweep leftovers from any crashed previous run in this output dir first.
    clean_stale(Path::new(&request.output_dir)).await;

    let temp_dir = PathBuf::from(&request.output_dir).join(TEMP_ROOT).join(&job_id.0);
    tokio::fs::create_dir_all(&temp_dir).await?;
    let partial = partial_path(&request.output_dir, &output_path, job_id);

    // Everything below runs under a guard that always cleans up temp + partial.
    let result = pipeline_body(app, request, job_id, token, hw, &output_path, &temp_dir, &partial).await;

    let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&partial).await;
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn pipeline_body(
    app: &AppHandle,
    request: &JobRequest,
    job_id: &JobId,
    token: &CancellationToken,
    hw: Option<HwEncoder>,
    output_path: &str,
    temp_dir: &Path,
    partial: &Path,
) -> AppResult<String> {
    phase(app, job_id, Phase::Probe);
    let media = probe::probe(app, &request.input_path).await?;
    bail_if_cancelled(token)?;

    let avail = EncoderAvailability { hw };
    let plan = resolve_output_plan(
        &media,
        request.quality,
        request.use_hardware,
        request.normalize_audio,
        &avail,
    )?;

    // No audio → nothing to silence-cut; copy the file through unchanged.
    if !media.has_audio() {
        log(app, job_id, LogLevel::Info, "no audio stream — copying as-is");
        tokio::fs::copy(&request.input_path, partial).await?;
        bail_if_cancelled(token)?;
        verify::publish(partial, Path::new(output_path)).await?;
        return Ok(output_path.to_string());
    }

    let video = media.video.as_ref().expect("plan requires a video stream");
    let fps = video.effective_fps();
    log(app, job_id, LogLevel::Info, format!(
        "Input: {} · {}×{} · {:.2} fps",
        fmt_dur(media.duration), video.width, video.height, fps.as_f64()
    ));

    // Editor supplies the cut ranges directly (preview == output); otherwise we
    // detect them ourselves (the plain Start flow).
    let silences = match &request.silence_ranges {
        Some(ranges) => {
            log(app, job_id, LogLevel::Info, format!("Using {} cut range(s) from the editor", ranges.len()));
            ranges.iter().map(|r| silence::SilenceRange { start: r[0], end: r[1] }).collect()
        }
        None => {
            phase(app, job_id, Phase::Detect);
            log(app, job_id, LogLevel::Info, "Analyzing audio for silence…");
            let s = silence::detect_silence(
                app,
                &request.input_path,
                request.silence_db,
                request.min_silence,
                media.duration,
            )
            .await?;
            bail_if_cancelled(token)?;
            s
        }
    };

    let removed_raw: f64 = silences.iter().map(|s| s.end - s.start).sum();
    log(app, job_id, LogLevel::Info, format!(
        "Found {} silent section(s) — about {} to cut", silences.len(), fmt_dur(removed_raw)
    ));
    for s in &silences {
        log(app, job_id, LogLevel::Info, format!("  ✂ {} → {}", fmt_ts(s.start), fmt_ts(s.end)));
    }

    // Editor ranges already include padding (computed client-side); don't apply
    // it again. Auto-detected ranges get the requested padding.
    let padding = if request.silence_ranges.is_some() { 0.0 } else { request.padding };
    let segments = timeline::build_timeline(&silences, media.duration, padding, fps);
    if segments.is_empty() {
        return Err(AppError::UnsupportedMedia(
            "no speech segments remain (whole clip is silence?)".into(),
        ));
    }
    let total_frames: u64 = segments.iter().map(|s| s.frame_count()).sum();
    let expected_duration = total_frames as f64 * fps.den as f64 / fps.num as f64;
    log(app, job_id, LogLevel::Info, format!(
        "Keeping {} clip(s): {} of {} ({} removed)",
        segments.len(), fmt_dur(expected_duration), fmt_dur(media.duration),
        fmt_dur(media.duration - expected_duration)
    ));

    // Optional two-pass loudness normalization, measured on the CUT timeline.
    let loudnorm_filter = if request.normalize_audio {
        phase(app, job_id, Phase::Measure);
        let script = temp_dir.join("measure.txt");
        let stats = loudnorm::measure_loudness(app, &request.input_path, &segments, fps, &script).await?;
        bail_if_cancelled(token)?;
        if stats.is_none() {
            log(app, job_id, LogLevel::Warn, "loudness measurement unavailable — single-pass loudnorm");
        }
        let resample = plan.audio.as_ref().and_then(|a| a.resample_hz);
        Some(loudnorm::build_loudnorm_filter(stats.as_ref(), resample))
    } else {
        None
    };

    let graph = filtergraph::build_filter_graph(&segments, fps, loudnorm_filter.as_deref());
    let script_path = temp_dir.join("filter.txt");
    tokio::fs::write(&script_path, &graph).await?;
    let script = script_path.to_string_lossy().to_string();
    let partial_str = partial.to_string_lossy().to_string();
    let gop = ((fps.as_f64() * 2.0).round() as u32).max(1);

    phase(app, job_id, Phase::Encode);
    log(app, job_id, LogLevel::Info, format!(
        "Encoding with {} ({})",
        plan.video.encoder, if plan.video.is_hardware { "GPU" } else { "CPU" }
    ));
    let active_plan = encode_with_fallback(
        app, job_id, token, &media, request, &avail, &plan, &request.input_path, &script,
        &partial_str, gop, expected_duration,
    )
    .await?;
    bail_if_cancelled(token)?;

    phase(app, job_id, Phase::Verify);
    verify::verify_output(app, &partial_str, &active_plan, expected_duration).await?;
    bail_if_cancelled(token)?;

    verify::publish(partial, Path::new(output_path)).await?;
    Ok(output_path.to_string())
}

/// Encode, and if a hardware encode fails, delete the partial and retry once
/// with a software plan. Cancellation is never retried.
#[allow(clippy::too_many_arguments)]
async fn encode_with_fallback(
    app: &AppHandle,
    job_id: &JobId,
    token: &CancellationToken,
    media: &crate::domain::media::MediaInfo,
    request: &JobRequest,
    avail: &EncoderAvailability,
    plan: &OutputPlan,
    input: &str,
    script: &str,
    partial: &str,
    gop: u32,
    expected_duration: f64,
) -> AppResult<OutputPlan> {
    let progress = make_progress_emitter(app, job_id);
    // ffmpeg's raw stderr is noisy (stream mapping spam); we emit our own
    // high-level logs instead, so the encoder's stderr is dropped from the UI.
    let logger = |_: &str| {};

    let args = encode::build_encode_args(plan, input, script, partial, gop);
    match encode::run_encode(app, args, expected_duration, token, &progress, &logger).await {
        Ok(()) => Ok(plan.clone()),
        Err(AppError::FfmpegExit { .. }) if plan.video.is_hardware && !token.is_cancelled() => {
            log(app, job_id, LogLevel::Warn, "hardware encode failed — retrying with software");
            let _ = tokio::fs::remove_file(partial).await;
            let sw_plan = resolve_output_plan(
                media, request.quality, false, request.normalize_audio,
                &EncoderAvailability { hw: None },
            )?;
            let _ = avail;
            let args = encode::build_encode_args(&sw_plan, input, script, partial, gop);
            encode::run_encode(app, args, expected_duration, token, &progress, &logger).await?;
            Ok(sw_plan)
        }
        Err(e) => Err(e),
    }
}

/// Progress emitter throttled to ~100ms so a per-frame stream doesn't flood the
/// frontend with events.
fn make_progress_emitter(app: &AppHandle, job_id: &JobId) -> impl Fn(f64) + Send + Sync {
    let app = app.clone();
    let job_id = job_id.clone();
    let last = Mutex::new(Instant::now() - Duration::from_millis(200));
    move |fraction: f64| {
        let mut l = last.lock().unwrap();
        if l.elapsed() >= Duration::from_millis(100) {
            *l = Instant::now();
            drop(l);
            emit(&app, JobEvent::Progress { job_id: job_id.clone(), fraction });
        }
    }
}

/// Format a duration as M:SS (e.g. 4:56).
fn fmt_dur(secs: f64) -> String {
    let s = secs.max(0.0).round() as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

/// Format a timestamp as M:SS.d (e.g. 1:23.4).
fn fmt_ts(secs: f64) -> String {
    let s = secs.max(0.0);
    format!("{}:{:04.1}", (s as u64) / 60, s % 60.0)
}

fn validate(request: &JobRequest) -> AppResult<()> {
    if !Path::new(&request.input_path).is_file() {
        return Err(AppError::InputValidation("input file does not exist".into()));
    }
    if !Path::new(&request.output_dir).is_dir() {
        return Err(AppError::InputValidation("output directory does not exist".into()));
    }
    if !request.silence_db.is_finite() || request.silence_db >= 0.0 {
        return Err(AppError::InputValidation("silence dB must be a negative number".into()));
    }
    if !request.min_silence.is_finite() || request.min_silence <= 0.0 {
        return Err(AppError::InputValidation("min silence must be positive".into()));
    }
    if !request.padding.is_finite() || request.padding < 0.0 {
        return Err(AppError::InputValidation("padding must be >= 0".into()));
    }
    Ok(())
}

fn build_output_path(output_dir: &str, input_path: &str) -> String {
    let name = Path::new(input_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("output");
    PathBuf::from(output_dir)
        .join(format!("processed_{name}"))
        .to_string_lossy()
        .to_string()
}

fn partial_path(output_dir: &str, output_path: &str, job_id: &JobId) -> PathBuf {
    // Same directory as the final output so the publish rename is atomic; keep
    // the real extension so ffmpeg's muxer autodetect still works.
    let ext = Path::new(output_path).extension().and_then(|e| e.to_str()).unwrap_or("mp4");
    PathBuf::from(output_dir).join(format!(".klyppr.{}.partial.{}", job_id.0, ext))
}

fn same_file(a: &str, b: &str) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => Path::new(a) == Path::new(b),
    }
}

/// Remove any leftover temp dirs / partial files from a crashed previous run in
/// the given output directory. Only touches our own `.klyppr_temp` and
/// `.klyppr.*.partial.*` names — never user files.
pub async fn clean_stale(output_dir: &Path) {
    let temp_root = output_dir.join(TEMP_ROOT);
    let _ = tokio::fs::remove_dir_all(&temp_root).await;
    if let Ok(mut rd) = tokio::fs::read_dir(output_dir).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(".klyppr.") && name.contains(".partial.") {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_path_prefixes_processed() {
        let p = build_output_path("/out", "/in/clip.mp4");
        assert_eq!(p, "/out/processed_clip.mp4");
    }

    #[test]
    fn partial_keeps_extension_and_dir() {
        let p = partial_path("/out", "/out/processed_clip.mkv", &JobId("abc".into()));
        assert_eq!(p, PathBuf::from("/out/.klyppr.abc.partial.mkv"));
    }

    #[test]
    fn validate_rejects_positive_db() {
        let req = JobRequest {
            input_path: "/no/such".into(),
            output_dir: "/tmp".into(),
            silence_db: 30.0,
            min_silence: 0.5,
            padding: 0.05,
            normalize_audio: false,
            quality: crate::domain::job::QualityPreset::Medium,
            use_hardware: true,
        };
        // input file check fails first, which is also InputValidation.
        assert!(validate(&req).is_err());
    }
}
