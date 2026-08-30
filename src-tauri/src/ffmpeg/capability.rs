use tauri::AppHandle;

use crate::ffmpeg::sidecar::ffmpeg_stderr;
use crate::pipeline::output_plan::HwEncoder;

/// Detect a usable hardware encoder by actually running a 1-frame test encode.
/// Listing an encoder in `-encoders` only means it was compiled in, not that a
/// GPU/driver is present — a real encode is the reliable signal. Result is
/// meant to be probed once and cached.
pub async fn detect_hw_encoder(app: &AppHandle) -> Option<HwEncoder> {
    #[cfg(target_os = "macos")]
    {
        if test_encoder(app, "h264_videotoolbox").await {
            return Some(HwEncoder::VideoToolbox);
        }
    }
    #[cfg(target_os = "windows")]
    {
        for (name, hw) in [
            ("h264_nvenc", HwEncoder::Nvenc),
            ("h264_qsv", HwEncoder::Qsv),
            ("h264_amf", HwEncoder::Amf),
        ] {
            if test_encoder(app, name).await {
                return Some(hw);
            }
        }
    }
    let _ = app;
    None
}

/// True if a tiny synthetic clip encodes cleanly with `encoder`.
async fn test_encoder(app: &AppHandle, encoder: &str) -> bool {
    ffmpeg_stderr(
        app,
        &[
            "-hide_banner",
            "-f", "lavfi",
            "-i", "color=c=black:s=64x64:d=1",
            "-frames:v", "1",
            "-c:v", encoder,
            "-f", "null", "-",
        ],
    )
    .await
    .is_ok()
}
