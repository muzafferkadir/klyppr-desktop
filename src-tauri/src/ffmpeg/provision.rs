use std::io::{Cursor, Read};
use std::path::PathBuf;

use futures_util::StreamExt;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::domain::error::{AppError, AppResult};

const MANIFEST: &str = include_str!("../../binaries/sidecars.json");
const SETUP_EVENT: &str = "ffmpeg-setup";

/// Compile-time target triple, matching the keys in sidecars.json.
const fn target_triple() -> &'static str {
    #[cfg(all(target_arch = "aarch64", target_os = "macos"))]
    { "aarch64-apple-darwin" }
    #[cfg(all(target_arch = "x86_64", target_os = "macos"))]
    { "x86_64-apple-darwin" }
    #[cfg(all(target_arch = "x86_64", target_os = "windows"))]
    { "x86_64-pc-windows-msvc" }
    #[cfg(not(any(
        all(target_arch = "aarch64", target_os = "macos"),
        all(target_arch = "x86_64", target_os = "macos"),
        all(target_arch = "x86_64", target_os = "windows")
    )))]
    { "unsupported" }
}

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

/// Directory where the downloaded ffmpeg/ffprobe live (app data dir, per-user).
pub fn bin_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(format!("no app data dir: {e}")))?
        .join("bin");
    Ok(dir)
}

pub fn ffmpeg_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(bin_dir(app)?.join(exe("ffmpeg")))
}

pub fn ffprobe_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(bin_dir(app)?.join(exe("ffprobe")))
}

/// Ensure ffmpeg + ffprobe are present in the app bin dir, downloading them on
/// first launch. Idempotent: returns immediately when both already exist.
/// Emits `ffmpeg-setup` events so the UI can show a one-time "preparing" state.
pub async fn ensure_ffmpeg(app: &AppHandle) -> AppResult<()> {
    let dir = bin_dir(app)?;
    let ffmpeg = ffmpeg_path(app)?;
    let ffprobe = ffprobe_path(app)?;
    if ffmpeg.is_file() && ffprobe.is_file() {
        return Ok(());
    }

    tokio::fs::create_dir_all(&dir).await?;
    let manifest: Value = serde_json::from_str(MANIFEST)
        .map_err(|e| AppError::Io(format!("bad sidecars manifest: {e}")))?;
    let target = manifest
        .get("targets")
        .and_then(|t| t.get(target_triple()))
        .ok_or_else(|| AppError::UnsupportedMedia(format!("no ffmpeg build for {}", target_triple())))?;

    let _ = app.emit(SETUP_EVENT, serde_json::json!({ "phase": "start" }));

    for (name, dest) in [("ffmpeg", &ffmpeg), ("ffprobe", &ffprobe)] {
        if dest.is_file() {
            continue;
        }
        let spec = target.get(name).ok_or_else(|| {
            AppError::Io(format!("manifest missing {name} for {}", target_triple()))
        })?;
        provision_one(app, name, spec, dest).await?;
    }

    let _ = app.emit(SETUP_EVENT, serde_json::json!({ "phase": "ready" }));
    Ok(())
}

async fn provision_one(app: &AppHandle, name: &str, spec: &Value, dest: &PathBuf) -> AppResult<()> {
    let url = spec.get("url").and_then(Value::as_str).ok_or_else(|| {
        AppError::Io(format!("manifest {name}: missing url"))
    })?;
    let member = spec.get("member").and_then(Value::as_str);
    let expected_sha = spec.get("sha256").and_then(Value::as_str).filter(|s| *s != "TODO");

    // Download the zip into memory with progress events.
    let resp = reqwest::get(url)
        .await
        .map_err(|e| AppError::Io(format!("download {name}: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::Io(format!("download {name}: {e}")))?;
    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut bytes: Vec<u8> = Vec::with_capacity(total as usize);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Io(format!("download {name}: {e}")))?;
        downloaded += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);
        let frac = if total > 0 { downloaded as f64 / total as f64 } else { 0.0 };
        let _ = app.emit(
            SETUP_EVENT,
            serde_json::json!({ "phase": "downloading", "binary": name, "fraction": frac }),
        );
    }

    // Extract the named member (all sources ship the binary inside a zip).
    let raw = match member {
        Some(m) => extract_zip_member(&bytes, m)?,
        None => bytes,
    };

    // Verify against the pinned hash when we have one; otherwise log the hash
    // so it can be pinned (source is HTTPS + reputable, but pinning is the goal).
    let actual = sha256_hex(&raw);
    match expected_sha {
        Some(sha) if sha != actual => {
            return Err(AppError::Io(format!(
                "{name} sha256 mismatch: expected {sha}, got {actual}"
            )));
        }
        Some(_) => {}
        None => {
            let _ = app.emit(
                SETUP_EVENT,
                serde_json::json!({ "phase": "unpinned", "binary": name, "sha256": actual }),
            );
        }
    }

    write_executable(dest, &raw).await?;
    sign_adhoc_if_macos(dest);
    Ok(())
}

fn extract_zip_member(zip_bytes: &[u8], member: &str) -> AppResult<Vec<u8>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip_bytes))
        .map_err(|e| AppError::Io(format!("open zip: {e}")))?;
    let mut file = archive
        .by_name(member)
        .map_err(|e| AppError::Io(format!("zip member '{member}': {e}")))?;
    let mut out = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut out)
        .map_err(|e| AppError::Io(format!("read zip member: {e}")))?;
    Ok(out)
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

async fn write_executable(dest: &PathBuf, data: &[u8]) -> AppResult<()> {
    tokio::fs::write(dest, data).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = tokio::fs::metadata(dest).await?.permissions();
        perm.set_mode(0o755);
        tokio::fs::set_permissions(dest, perm).await?;
    }
    Ok(())
}

/// Ad-hoc sign so arm64 macOS will run the freshly-written binary.
fn sign_adhoc_if_macos(dest: &PathBuf) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("codesign")
            .args(["--force", "--sign", "-"])
            .arg(dest)
            .status();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = dest;
    }
}
