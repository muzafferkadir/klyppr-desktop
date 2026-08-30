use crate::domain::error::{AppError, AppResult};
use crate::domain::job::QualityPreset;
use crate::domain::media::{MediaInfo, Rational, VideoCodec};

/// Which GPU encoder family the host actually has (probed in the encode stage;
/// passed in so this resolver stays pure and testable). v1 implements Apple
/// VideoToolbox; the Windows families are placeholders wired up with CI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HwEncoder {
    VideoToolbox,
    Nvenc,
    Qsv,
    Amf,
}

#[derive(Debug, Clone, Default)]
pub struct EncoderAvailability {
    pub hw: Option<HwEncoder>,
}

/// Output container, derived from the input extension (we keep the same
/// container the file came in as).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
    Mp4,
    Mov,
    Mkv,
    Webm,
}

impl Container {
    fn from_ext(ext: &str) -> AppResult<Container> {
        match ext {
            "mp4" | "m4v" => Ok(Container::Mp4),
            "mov" => Ok(Container::Mov),
            "mkv" => Ok(Container::Mkv),
            "webm" => Ok(Container::Webm),
            other => Err(AppError::UnsupportedMedia(format!(
                "container .{other} is not supported yet"
            ))),
        }
    }

    /// ISO-BMFF containers get hvc1 tagging and +faststart; others must not.
    fn is_iso_bmff(self) -> bool {
        matches!(self, Container::Mp4 | Container::Mov)
    }

    fn muxer(self) -> &'static str {
        match self {
            Container::Mp4 => "mp4",
            Container::Mov => "mov",
            Container::Mkv => "matroska",
            Container::Webm => "webm",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoEncodePlan {
    pub encoder: String,
    pub is_hardware: bool,
    pub pix_fmt: String,
    pub quality_args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioEncodePlan {
    pub encoder: String,
    pub bitrate: String,
    /// When the source rate is known, re-sample loudnorm's output back to it —
    /// loudnorm internally upsamples to 192 kHz and would otherwise emit a
    /// 192 kHz file. `None` when we don't know the rate.
    pub resample_hz: Option<u32>,
}

/// Everything the encode stage needs, decided in ONE place. Nothing downstream
/// re-derives codec/pix_fmt/tag choices.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputPlan {
    pub container: Container,
    pub output_ext: String,
    pub muxer: &'static str,
    pub cfr_fps: Rational,
    pub video: VideoEncodePlan,
    /// `None` = no audio stream (video-only copy of the plan).
    pub audio: Option<AudioEncodePlan>,
    pub video_tag: Option<&'static str>,
    pub faststart: bool,
}

/// Resolve the output plan from the input, request, and hardware availability.
/// Pure and total: unsupported combinations return an error rather than a
/// silent fallback (silent codec/pix_fmt swaps are how A/V bugs hide).
pub fn resolve_output_plan(
    media: &MediaInfo,
    quality: QualityPreset,
    use_hardware: bool,
    normalize_audio: bool,
    avail: &EncoderAvailability,
) -> AppResult<OutputPlan> {
    let container = Container::from_ext(&media.input_ext)?;
    let video_stream = media
        .video
        .as_ref()
        .ok_or_else(|| AppError::UnsupportedMedia("no video stream to encode".into()))?;

    // Target video codec is container-driven; input codec only nudges the MP4/MOV
    // and MKV choice. We never let "keep input codec" be the primary decision.
    let target = target_video_codec(container, &video_stream.codec);
    let hw = if use_hardware { avail.hw } else { None };
    let video = build_video_plan(target, hw, quality);

    let cfr_fps = video_stream.effective_fps();
    let video_tag = (container.is_iso_bmff() && target == TargetVideo::Hevc).then_some("hvc1");

    let audio = if media.has_audio() {
        Some(build_audio_plan(container, media, normalize_audio)?)
    } else {
        None
    };

    Ok(OutputPlan {
        output_ext: media.input_ext.clone(),
        muxer: container.muxer(),
        container,
        cfr_fps,
        video,
        audio,
        video_tag,
        faststart: container.is_iso_bmff(),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TargetVideo {
    H264,
    Hevc,
    Vp9,
    Av1,
}

fn target_video_codec(container: Container, input: &VideoCodec) -> TargetVideo {
    match container {
        // MP4/MOV: keep HEVC if it came in as HEVC (tag hvc1), otherwise H.264.
        Container::Mp4 | Container::Mov => match input {
            VideoCodec::Hevc => TargetVideo::Hevc,
            _ => TargetVideo::H264,
        },
        // MKV takes anything mainstream; keep it, default unknown to H.264.
        Container::Mkv => match input {
            VideoCodec::Hevc => TargetVideo::Hevc,
            VideoCodec::Vp9 => TargetVideo::Vp9,
            VideoCodec::Av1 => TargetVideo::Av1,
            _ => TargetVideo::H264,
        },
        // WebM is VP9/AV1 only.
        Container::Webm => match input {
            VideoCodec::Av1 => TargetVideo::Av1,
            _ => TargetVideo::Vp9,
        },
    }
}

fn build_video_plan(target: TargetVideo, hw: Option<HwEncoder>, quality: QualityPreset) -> VideoEncodePlan {
    // v1: normalize every output to 8-bit yuv420p — maximum player compatibility
    // (QuickTime included) and it keeps hardware encoders on their happy path.
    // 10-bit / 4:2:2 passthrough is a deliberate later feature.
    let pix_fmt = "yuv420p".to_string();

    // Hardware only for H.264/HEVC on VideoToolbox in v1; everything else is
    // software. VP9/AV1 stay software (libvpx/libsvtav1).
    if let (Some(HwEncoder::VideoToolbox), true) =
        (hw, matches!(target, TargetVideo::H264 | TargetVideo::Hevc))
    {
        let encoder = match target {
            TargetVideo::Hevc => "hevc_videotoolbox",
            _ => "h264_videotoolbox",
        };
        let q = match quality {
            QualityPreset::Fast => 35,
            QualityPreset::Medium => 55,
            QualityPreset::High => 75,
            QualityPreset::Lossless => 90,
        };
        return VideoEncodePlan {
            encoder: encoder.to_string(),
            is_hardware: true,
            pix_fmt,
            quality_args: vec!["-q:v".into(), q.to_string()],
        };
    }

    let (encoder, quality_args) = match target {
        TargetVideo::H264 => ("libx264", crf_args("libx264", quality)),
        TargetVideo::Hevc => ("libx265", crf_args("libx265", quality)),
        TargetVideo::Vp9 => ("libvpx-vp9", vec!["-crf".into(), crf(quality).to_string(), "-b:v".into(), "0".into()]),
        TargetVideo::Av1 => ("libsvtav1", vec!["-crf".into(), crf(quality).to_string(), "-preset".into(), if matches!(quality, QualityPreset::Fast) { "10" } else { "6" }.into()]),
    };
    VideoEncodePlan {
        encoder: encoder.to_string(),
        is_hardware: false,
        pix_fmt,
        quality_args,
    }
}

fn crf(quality: QualityPreset) -> u32 {
    match quality {
        QualityPreset::Fast => 28,
        QualityPreset::Medium => 23,
        QualityPreset::High => 18,
        QualityPreset::Lossless => 16,
    }
}

fn crf_args(encoder: &str, quality: QualityPreset) -> Vec<String> {
    let preset = match quality {
        QualityPreset::Fast => "veryfast",
        QualityPreset::High | QualityPreset::Lossless => "medium",
        QualityPreset::Medium => if encoder == "libx265" { "fast" } else { "veryfast" },
    };
    vec!["-preset".into(), preset.into(), "-crf".into(), crf(quality).to_string()]
}

fn build_audio_plan(
    container: Container,
    media: &MediaInfo,
    normalize_audio: bool,
) -> AppResult<AudioEncodePlan> {
    // Container decides the audio codec — AAC isn't valid in WebM, Opus is.
    let encoder = match container {
        Container::Mp4 | Container::Mov | Container::Mkv => "aac",
        Container::Webm => "libopus",
    };

    let src = media.audios.first();
    // Keep the source bitrate when it's a sane value, else a safe default.
    // A reported 0 (or absurdly high) would otherwise produce "0k" / a failing
    // encode. Cap at 320k — well above transparent for AAC/Opus.
    let bitrate = src
        .and_then(|a| a.bit_rate)
        .filter(|&b| b > 0)
        .map(|b| ((b as f64 / 1000.0).round() as u32).clamp(32, 320))
        .map(|kbps| format!("{kbps}k"))
        .unwrap_or_else(|| "320k".to_string());

    let resample_hz = if normalize_audio {
        src.map(|a| a.sample_rate)
    } else {
        None
    };

    Ok(AudioEncodePlan {
        encoder: encoder.to_string(),
        bitrate,
        resample_hz,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::media::{AudioCodec, AudioStream, VideoStream};

    fn media(ext: &str, vcodec: VideoCodec, with_audio: bool) -> MediaInfo {
        MediaInfo {
            input_ext: ext.into(),
            duration: 10.0,
            video: Some(VideoStream {
                index: 0,
                codec: vcodec,
                pix_fmt: "yuv420p".into(),
                r_frame_rate: Rational { num: 30, den: 1 },
                avg_frame_rate: Some(Rational { num: 30, den: 1 }),
                width: 1920,
                height: 1080,
                start_time: 0.0,
                rotation: 0,
            }),
            audios: if with_audio {
                vec![AudioStream { index: 1, codec: AudioCodec::Aac, sample_rate: 48000, channels: 2, bit_rate: Some(256000) }]
            } else {
                vec![]
            },
        }
    }

    fn plan(m: &MediaInfo, hw: Option<HwEncoder>, normalize: bool) -> AppResult<OutputPlan> {
        resolve_output_plan(m, QualityPreset::Medium, hw.is_some(), normalize, &EncoderAvailability { hw })
    }

    #[test]
    fn mp4_h264_no_hvc1_tag() {
        let p = plan(&media("mp4", VideoCodec::H264, true), None, false).unwrap();
        assert_eq!(p.video.encoder, "libx264");
        assert_eq!(p.video_tag, None);
        assert!(p.faststart);
        assert_eq!(p.audio.unwrap().encoder, "aac");
    }

    #[test]
    fn mp4_hevc_gets_hvc1() {
        let p = plan(&media("mp4", VideoCodec::Hevc, true), None, false).unwrap();
        assert_eq!(p.video.encoder, "libx265");
        assert_eq!(p.video_tag, Some("hvc1"));
    }

    #[test]
    fn mkv_hevc_has_no_hvc1_or_faststart() {
        let p = plan(&media("mkv", VideoCodec::Hevc, true), None, false).unwrap();
        assert_eq!(p.video_tag, None);
        assert!(!p.faststart);
    }

    #[test]
    fn webm_forces_vp9_and_opus() {
        let p = plan(&media("webm", VideoCodec::H264, true), None, false).unwrap();
        assert_eq!(p.video.encoder, "libvpx-vp9");
        assert_eq!(p.audio.unwrap().encoder, "libopus");
    }

    #[test]
    fn videotoolbox_used_for_h264_when_available() {
        let p = plan(&media("mp4", VideoCodec::H264, true), Some(HwEncoder::VideoToolbox), false).unwrap();
        assert_eq!(p.video.encoder, "h264_videotoolbox");
        assert!(p.video.is_hardware);
    }

    #[test]
    fn no_audio_gives_video_only_plan() {
        let p = plan(&media("mp4", VideoCodec::H264, false), None, false).unwrap();
        assert!(p.audio.is_none());
    }

    #[test]
    fn normalize_sets_resample_to_source_rate() {
        let p = plan(&media("mp4", VideoCodec::H264, true), None, true).unwrap();
        assert_eq!(p.audio.unwrap().resample_hz, Some(48000));
    }

    #[test]
    fn unsupported_container_errors() {
        assert!(plan(&media("avi", VideoCodec::H264, true), None, false).is_err());
    }
}
