use std::path::Path;
use std::process::Stdio;

use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::domain::error::{AppError, AppResult};
use crate::ffmpeg::provision::{ffmpeg_path, ffprobe_path};
use crate::pipeline::encode::parse_progress;

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

/// Run ffmpeg streaming its `-progress pipe:1` on stdout (parsed into a [0,1)
/// fraction via `expected_duration`) while capturing the full stderr (for
/// loudnorm's JSON block). Unlike [`ffmpeg_stderr`], this spawns a child and
/// selects on `token`, so Cancel actually kills the process mid-run instead of
/// waiting for it to finish. Returns the captured stderr on success.
pub async fn ffmpeg_stderr_progress(
    app: &AppHandle,
    args: &[&str],
    expected_duration: f64,
    token: &CancellationToken,
    on_progress: &(dyn Fn(f64) + Send + Sync),
) -> AppResult<String> {
    let mut child = Command::new(ffmpeg_path(app)?)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::SidecarSpawn(format!("ffmpeg: {e}")))?;

    let mut out = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut err = BufReader::new(child.stderr.take().unwrap()).lines();
    let mut out_open = true;
    let mut err_open = true;
    let mut stderr = String::new();

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
                    stderr.push_str(&l);
                    stderr.push('\n');
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
        Ok(stderr)
    } else {
        Err(AppError::FfmpegExit {
            code: status.code(),
            stderr_tail: stderr_tail(stderr.as_bytes()),
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
