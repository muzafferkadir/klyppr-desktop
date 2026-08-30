use std::path::Path;

use tauri::AppHandle;
use tokio::process::Command;

use crate::domain::error::{AppError, AppResult};
use crate::ffmpeg::provision::{ffmpeg_path, ffprobe_path};

/// Keep the last few stderr lines for error messages (ffmpeg puts the real
/// reason at the very end).
fn stderr_tail(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(3);
    lines[start..].join(" | ")
}

/// Run a provisioned binary to completion, returning stdout. Used for short,
/// buffered calls (ffprobe, `-version`).
async fn run_capture_stdout(bin: &Path, args: &[&str]) -> AppResult<String> {
    let output = Command::new(bin)
        .args(args)
        .output()
        .await
        .map_err(|e| AppError::SidecarSpawn(format!("{}: {e}", bin.display())))?;

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
    run_capture_stdout(&ffprobe_path(app)?, args).await
}

/// Run ffmpeg to completion and return its STDERR (silencedetect, loudnorm json,
/// and `-f null -` all report there and exit 0 on success).
pub async fn ffmpeg_stderr(app: &AppHandle, args: &[&str]) -> AppResult<String> {
    let output = Command::new(ffmpeg_path(app)?)
        .args(args)
        .output()
        .await
        .map_err(|e| AppError::SidecarSpawn(format!("ffmpeg: {e}")))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stderr).into_owned())
    } else {
        Err(AppError::FfmpegExit {
            code: output.status.code(),
            stderr_tail: stderr_tail(&output.stderr),
        })
    }
}

/// First line of `ffprobe -version` — a smoke test that the provisioned binary
/// is present and runnable.
pub async fn ffprobe_version(app: &AppHandle) -> AppResult<String> {
    let out = ffprobe(app, &["-version"]).await?;
    Ok(out.lines().next().unwrap_or("").to_string())
}

/// Run ffmpeg and return raw STDOUT bytes (for binary output like PCM).
pub async fn ffmpeg_stdout_bytes(app: &AppHandle, args: &[&str]) -> AppResult<Vec<u8>> {
    let output = Command::new(ffmpeg_path(app)?)
        .args(args)
        .output()
        .await
        .map_err(|e| AppError::SidecarSpawn(format!("ffmpeg: {e}")))?;

    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(AppError::FfmpegExit {
            code: output.status.code(),
            stderr_tail: stderr_tail(&output.stderr),
        })
    }
}
