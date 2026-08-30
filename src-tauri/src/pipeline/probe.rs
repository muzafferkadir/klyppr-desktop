use std::path::Path;

use serde_json::Value;
use tauri::AppHandle;

use crate::domain::error::{AppError, AppResult};
use crate::domain::media::{
    AudioCodec, AudioStream, MediaInfo, Rational, VideoCodec, VideoStream,
};
use crate::ffmpeg::sidecar::ffprobe;

/// Run ffprobe and build a validated `MediaInfo`. Chooses the primary video
/// stream (skipping attached-pic / cover-art), collects every audio stream,
/// and falls back to a stream duration when the container has none.
pub async fn probe(app: &AppHandle, input_path: &str) -> AppResult<MediaInfo> {
    let json = ffprobe(
        app,
        &[
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            input_path,
        ],
    )
    .await?;

    let root: Value =
        serde_json::from_str(&json).map_err(|e| AppError::Probe(format!("bad ffprobe json: {e}")))?;

    let empty = Vec::new();
    let streams = root.get("streams").and_then(Value::as_array).unwrap_or(&empty);

    let video = pick_video(streams);
    let audios = collect_audio(streams);
    let duration = pick_duration(&root, streams);

    if video.is_none() && audios.is_empty() {
        return Err(AppError::UnsupportedMedia(
            "no decodable video or audio stream found".into(),
        ));
    }

    let input_ext = Path::new(input_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    Ok(MediaInfo {
        input_ext,
        duration,
        video,
        audios,
    })
}

fn str_field<'a>(s: &'a Value, key: &str) -> Option<&'a str> {
    s.get(key).and_then(Value::as_str)
}

fn is_attached_pic(s: &Value) -> bool {
    s.get("disposition")
        .and_then(|d| d.get("attached_pic"))
        .and_then(Value::as_i64)
        == Some(1)
}

fn pick_video(streams: &[Value]) -> Option<VideoStream> {
    let s = streams
        .iter()
        .find(|s| str_field(s, "codec_type") == Some("video") && !is_attached_pic(s))?;

    let index = s.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
    let codec = VideoCodec::from_ffprobe(str_field(s, "codec_name").unwrap_or("h264"));
    let pix_fmt = str_field(s, "pix_fmt").unwrap_or("yuv420p").to_string();
    let r_frame_rate = str_field(s, "r_frame_rate")
        .and_then(Rational::parse)
        .unwrap_or(Rational { num: 30, den: 1 });
    let avg_frame_rate = str_field(s, "avg_frame_rate").and_then(Rational::parse);
    let width = s.get("width").and_then(Value::as_u64).unwrap_or(0) as u32;
    let height = s.get("height").and_then(Value::as_u64).unwrap_or(0) as u32;
    let start_time = str_field(s, "start_time")
        .and_then(|t| t.parse::<f64>().ok())
        .unwrap_or(0.0);
    let rotation = parse_rotation(s);

    Some(VideoStream {
        index,
        codec,
        pix_fmt,
        r_frame_rate,
        avg_frame_rate,
        width,
        height,
        start_time,
        rotation,
    })
}

/// Rotation from either tags.rotate or a display-matrix side_data entry.
fn parse_rotation(s: &Value) -> i32 {
    if let Some(r) = s
        .get("tags")
        .and_then(|t| t.get("rotate"))
        .and_then(Value::as_str)
        .and_then(|r| r.parse::<i32>().ok())
    {
        return r;
    }
    s.get("side_data_list")
        .and_then(Value::as_array)
        .and_then(|list| list.iter().find_map(|d| d.get("rotation")))
        .and_then(Value::as_i64)
        .map(|r| r as i32)
        .unwrap_or(0)
}

fn collect_audio(streams: &[Value]) -> Vec<AudioStream> {
    streams
        .iter()
        .filter(|s| str_field(s, "codec_type") == Some("audio"))
        .map(|s| AudioStream {
            index: s.get("index").and_then(Value::as_u64).unwrap_or(0) as usize,
            codec: AudioCodec::from_ffprobe(str_field(s, "codec_name").unwrap_or("aac")),
            sample_rate: str_field(s, "sample_rate")
                .and_then(|r| r.parse::<u32>().ok())
                .unwrap_or(48000),
            channels: s.get("channels").and_then(Value::as_u64).unwrap_or(2) as u32,
            bit_rate: str_field(s, "bit_rate").and_then(|r| r.parse::<u32>().ok()),
        })
        .collect()
}

/// Prefer container duration; fall back to the longest stream duration.
fn pick_duration(root: &Value, streams: &[Value]) -> f64 {
    if let Some(d) = root
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(Value::as_str)
        .and_then(|d| d.parse::<f64>().ok())
    {
        if d > 0.0 {
            return d;
        }
    }
    streams
        .iter()
        .filter_map(|s| str_field(s, "duration").and_then(|d| d.parse::<f64>().ok()))
        .fold(0.0_f64, f64::max)
}
