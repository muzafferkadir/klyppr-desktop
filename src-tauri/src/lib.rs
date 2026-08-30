mod domain;
mod ffmpeg;
mod pipeline;

use domain::error::AppErrorDto;
use domain::media::MediaInfo;

/// Startup smoke test: confirm the bundled ffprobe sidecar runs.
#[tauri::command]
async fn ffprobe_version(app: tauri::AppHandle) -> Result<String, AppErrorDto> {
    ffmpeg::sidecar::ffprobe_version(&app)
        .await
        .map_err(|e| e.to_dto())
}

/// Probe an input file into a validated MediaInfo (temporary command — the UI
/// will call it via the job pipeline once that lands).
#[tauri::command]
async fn probe_media(app: tauri::AppHandle, input_path: String) -> Result<MediaInfo, AppErrorDto> {
    pipeline::probe::probe(&app, &input_path)
        .await
        .map_err(|e| e.to_dto())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![ffprobe_version, probe_media])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
