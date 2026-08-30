use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

use crate::domain::error::{AppError, AppResult};

/// Keep the last few stderr lines for error messages (ffmpeg puts the real
/// reason at the very end).
fn stderr_tail(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(3);
    lines[start..].join(" | ")
}

/// Run a bundled sidecar to completion and return stdout as UTF-8. Used for
/// short, buffered calls (ffprobe, `-version`). Streaming encode/detect calls
/// live in the pipeline runner, not here.
async fn run_capture(app: &AppHandle, bin: &str, args: &[&str]) -> AppResult<String> {
    let output = app
        .shell()
        .sidecar(bin)
        .map_err(|e| AppError::SidecarMissing(format!("{bin}: {e}")))?
        .args(args)
        .output()
        .await
        .map_err(|e| AppError::SidecarSpawn(format!("{bin}: {e}")))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(AppError::FfmpegExit {
            code: output.status.code(),
            stderr_tail: stderr_tail(&output.stderr),
        })
    }
}

/// Run ffprobe with the given args, capturing stdout.
pub async fn ffprobe(app: &AppHandle, args: &[&str]) -> AppResult<String> {
    run_capture(app, "ffprobe", args).await
}

/// First line of `ffprobe -version` — a startup smoke test that the bundled
/// sidecar is present, signed, and runnable.
pub async fn ffprobe_version(app: &AppHandle) -> AppResult<String> {
    let out = ffprobe(app, &["-version"]).await?;
    Ok(out.lines().next().unwrap_or("").to_string())
}
