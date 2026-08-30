use serde::Serialize;

/// An exact frame rate as a rational (e.g. 30000/1001 for NTSC 29.97). Kept
/// rational — never collapsed to f64 for filter args — so cut points snap to
/// the true frame grid without NTSC rounding drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Rational {
    pub num: u32,
    pub den: u32,
}

impl Rational {
    pub fn new(num: u32, den: u32) -> Option<Self> {
        if num == 0 || den == 0 {
            None
        } else {
            Some(Rational { num, den })
        }
    }

    /// Parse an ffprobe rate string like "30000/1001" or "25/1".
    pub fn parse(s: &str) -> Option<Self> {
        let (n, d) = s.split_once('/')?;
        Rational::new(n.trim().parse().ok()?, d.trim().parse().ok()?)
    }

    pub fn as_f64(self) -> f64 {
        self.num as f64 / self.den as f64
    }

    /// FFmpeg-ready exact form, e.g. "30000/1001".
    pub fn as_ffmpeg(self) -> String {
        format!("{}/{}", self.num, self.den)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "name", content = "raw")]
pub enum VideoCodec {
    H264,
    Hevc,
    Vp9,
    Av1,
    Mpeg4,
    ProRes,
    Mjpeg,
    /// Anything we don't explicitly model — carried through, never silently
    /// downgraded to H.264 (that was a legacy footgun).
    Unknown(String),
}

impl VideoCodec {
    pub fn from_ffprobe(name: &str) -> Self {
        match name.to_ascii_lowercase().as_str() {
            "h264" => VideoCodec::H264,
            "hevc" | "h265" => VideoCodec::Hevc,
            "vp9" => VideoCodec::Vp9,
            "av1" => VideoCodec::Av1,
            "mpeg4" => VideoCodec::Mpeg4,
            "prores" => VideoCodec::ProRes,
            "mjpeg" | "png" | "bmp" => VideoCodec::Mjpeg,
            other => VideoCodec::Unknown(other.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "name", content = "raw")]
pub enum AudioCodec {
    Aac,
    Mp3,
    Opus,
    Vorbis,
    Ac3,
    Eac3,
    Flac,
    Alac,
    PcmS16le,
    PcmS24le,
    Unknown(String),
}

impl AudioCodec {
    pub fn from_ffprobe(name: &str) -> Self {
        match name.to_ascii_lowercase().as_str() {
            "aac" => AudioCodec::Aac,
            "mp3" => AudioCodec::Mp3,
            "opus" => AudioCodec::Opus,
            "vorbis" => AudioCodec::Vorbis,
            "ac3" => AudioCodec::Ac3,
            "eac3" => AudioCodec::Eac3,
            "flac" => AudioCodec::Flac,
            "alac" => AudioCodec::Alac,
            "pcm_s16le" => AudioCodec::PcmS16le,
            "pcm_s24le" => AudioCodec::PcmS24le,
            other => AudioCodec::Unknown(other.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStream {
    pub index: usize,
    pub codec: VideoCodec,
    pub pix_fmt: String,
    /// r_frame_rate — the *maximum* rate (may be inflated on TS/AVI).
    pub r_frame_rate: Rational,
    /// avg_frame_rate — the real average; preferred when r looks bogus.
    pub avg_frame_rate: Option<Rational>,
    pub width: u32,
    pub height: u32,
    pub start_time: f64,
    /// Display rotation in degrees (from side_data / tags), for later use.
    pub rotation: i32,
}

impl VideoStream {
    /// The frame rate to build the CFR grid from: trust avg when r_frame_rate
    /// is inflated (r > 1.5x avg), then clamp to a sane 5–240 range so a bogus
    /// TS/AVI rate can't emit -r 90000 and blow up the encoder.
    pub fn effective_fps(&self) -> Rational {
        let r = self.r_frame_rate;
        let chosen = match self.avg_frame_rate {
            Some(avg) if r.as_f64() > avg.as_f64() * 1.5 => avg,
            _ => r,
        };
        clamp_fps(chosen)
    }
}

fn clamp_fps(r: Rational) -> Rational {
    let f = r.as_f64();
    if f < 5.0 {
        Rational { num: 5, den: 1 }
    } else if f > 240.0 {
        Rational { num: 240, den: 1 }
    } else {
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(n: u32, d: u32) -> Rational {
        Rational { num: n, den: d }
    }

    fn vs(rfr: Rational, avg: Option<Rational>) -> VideoStream {
        VideoStream {
            index: 0,
            codec: VideoCodec::H264,
            pix_fmt: "yuv420p".into(),
            r_frame_rate: rfr,
            avg_frame_rate: avg,
            width: 1920,
            height: 1080,
            start_time: 0.0,
            rotation: 0,
        }
    }

    #[test]
    fn rational_parse() {
        assert_eq!(Rational::parse("30000/1001"), Some(r(30000, 1001)));
        assert_eq!(Rational::parse("25/1"), Some(r(25, 1)));
        assert_eq!(Rational::parse("0/0"), None);
        assert_eq!(Rational::parse("30"), None);
        assert_eq!(r(30000, 1001).as_ffmpeg(), "30000/1001");
    }

    #[test]
    fn effective_fps_trusts_avg_when_r_is_inflated() {
        // NTSC: r == avg → keep it exact (no drift).
        assert_eq!(vs(r(30000, 1001), Some(r(30000, 1001))).effective_fps(), r(30000, 1001));
        // Bogus TS/AVI r_frame_rate (90 vs real 30) → fall back to avg.
        assert_eq!(vs(r(90, 1), Some(r(30, 1))).effective_fps(), r(30, 1));
        assert_eq!(vs(r(90000, 1), Some(r(30, 1))).effective_fps(), r(30, 1));
        // Genuine 90 fps (r == avg) stays 90.
        assert_eq!(vs(r(90, 1), Some(r(90, 1))).effective_fps(), r(90, 1));
    }

    #[test]
    fn effective_fps_clamps_out_of_range() {
        // Above 240 with no avg → clamped to 240.
        assert_eq!(vs(r(1000, 1), None).effective_fps().as_f64(), 240.0);
        // Below 5 → clamped to 5.
        assert_eq!(vs(r(2, 1), None).effective_fps().as_f64(), 5.0);
    }

    #[test]
    fn video_codec_mapping() {
        assert_eq!(VideoCodec::from_ffprobe("h264"), VideoCodec::H264);
        assert_eq!(VideoCodec::from_ffprobe("HEVC"), VideoCodec::Hevc);
        assert_eq!(VideoCodec::from_ffprobe("h265"), VideoCodec::Hevc);
        assert_eq!(
            VideoCodec::from_ffprobe("theora"),
            VideoCodec::Unknown("theora".into())
        );
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStream {
    pub index: usize,
    pub codec: AudioCodec,
    pub sample_rate: u32,
    pub channels: u32,
    pub bit_rate: Option<u32>,
}

/// Validated, immutable description of an input file. Built once by `probe`;
/// downstream stages only read it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    /// Lowercased container extension of the input path (e.g. "mp4", "mkv").
    pub input_ext: String,
    pub duration: f64,
    /// Primary (non-attached-pic) video stream, if any.
    pub video: Option<VideoStream>,
    /// All audio streams, in file order.
    pub audios: Vec<AudioStream>,
}

impl MediaInfo {
    pub fn has_audio(&self) -> bool {
        !self.audios.is_empty()
    }
}
