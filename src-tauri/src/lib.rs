mod domain;
mod ffmpeg;
mod pipeline;
mod state;

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};
use tokio::sync::OnceCell;

use domain::error::AppErrorDto;
use domain::job::{JobEvent, JobId, JobRequest};
use domain::media::MediaInfo;
use pipeline::output_plan::HwEncoder;
use state::job_manager::JobManager;

/// App-wide shared state: the single-job manager and a lazily-detected,
/// cached hardware-encoder result.
#[derive(Default)]
struct AppState {
    jobs: Arc<JobManager>,
    hw: OnceCell<Option<HwEncoder>>,
}

const EVENT: &str = "job-event";

/// Ensure the ffmpeg/ffprobe binaries are provisioned (downloaded on first run).
#[tauri::command]
async fn ensure_ffmpeg(app: AppHandle) -> Result<(), AppErrorDto> {
    ffmpeg::provision::ensure_ffmpeg(&app).await.map_err(|e| e.to_dto())
}

/// Startup smoke test: confirm ffprobe runs.
#[tauri::command]
async fn ffprobe_version(app: AppHandle) -> Result<String, AppErrorDto> {
    ffmpeg::sidecar::ffprobe_version(&app).await.map_err(|e| e.to_dto())
}

/// Probe an input file into a validated MediaInfo.
#[tauri::command]
async fn probe_media(app: AppHandle, input_path: String) -> Result<MediaInfo, AppErrorDto> {
    ffmpeg::provision::ensure_ffmpeg(&app).await.map_err(|e| e.to_dto())?;
    pipeline::probe::probe(&app, &input_path).await.map_err(|e| e.to_dto())
}

/// Start processing. Returns a JobId immediately and runs the pipeline in the
/// background, emitting `job-event`s. Rejects if a job is already running.
#[tauri::command]
async fn start_job(
    app: AppHandle,
    state: State<'_, AppState>,
    request: JobRequest,
) -> Result<JobId, AppErrorDto> {
    // Make sure ffmpeg is present before we claim the job slot.
    ffmpeg::provision::ensure_ffmpeg(&app).await.map_err(|e| e.to_dto())?;

    let job_id = JobId::new();
    let token = state.jobs.try_start(job_id.clone()).ok_or_else(|| AppErrorDto {
        kind: "jobBusy".into(),
        message: "a job is already running".into(),
    })?;

    let app_for_hw = app.clone();
    let hw = *state
        .hw
        .get_or_init(|| async move { ffmpeg::capability::detect_hw_encoder(&app_for_hw).await })
        .await;

    let jobs = state.jobs.clone();
    let jid = job_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = pipeline::orchestrator::run_pipeline(&app, &request, &jid, &token, hw).await;
        let terminal = match result {
            Ok(output_path) => JobEvent::Finished { job_id: jid.clone(), output_path },
            Err(e) if matches!(e, domain::error::AppError::Cancelled) => {
                JobEvent::Cancelled { job_id: jid.clone() }
            }
            Err(e) => JobEvent::Failed { job_id: jid.clone(), error: e.to_dto() },
        };
        let _ = app.emit(EVENT, terminal);
        jobs.finish(&jid);
    });

    Ok(job_id)
}

/// Cancel a running job by id. Returns whether it was the active job.
#[tauri::command]
fn cancel_job(state: State<'_, AppState>, job_id: JobId) -> bool {
    state.jobs.cancel(&job_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .setup(|app| {
            // Proactively provision ffmpeg on launch so the first job is instant.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = ffmpeg::provision::ensure_ffmpeg(&handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ensure_ffmpeg,
            ffprobe_version,
            probe_media,
            start_job,
            cancel_job
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
