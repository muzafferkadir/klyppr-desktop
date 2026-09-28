use crate::domain::media::Rational;
use crate::pipeline::timeline::Segment;

/// Build a concat-demuxer script that keeps every speech segment and drops the silence between them.
pub fn build_concat_list(segments: &[Segment], fps: Rational, input_path: &str) -> String {
    let file = escape_concat_path(input_path);
    let mut out = String::from("ffconcat version 1.0\n");
    for seg in segments {
        out.push_str(&format!(
            "file {file}\ninpoint {:.6}\noutpoint {:.6}\n",
            seg.start_secs(fps),
            seg.end_secs(fps)
        ));
    }
    out
}

/// The audio filter chain applied on top of the concat-demuxer output.
pub fn build_audio_filter(loudnorm: Option<&str>) -> String {
    let retime = "aresample=async=1:first_pts=0,asetpts=N/SR/TB";
    match loudnorm {
        Some(ln) => format!("{retime},{ln}"),
        None => retime.to_string(),
    }
}

/// Wrap a path for the concat demuxer's `file` directive: single-quote it and escape any embedded single quotes as `'\''`.
fn escape_concat_path(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

/// Build a frame-accurate `filter_complex` graph that trims each kept segment straight off the single decoded input and concats them.
pub fn build_trim_concat_filter(
    segments: &[Segment],
    fps: Rational,
    loudnorm: Option<&str>,
    has_audio: bool,
    sample_rate: u32,
) -> String {
    let rate = fps.as_ffmpeg();
    let mut g = String::new();
    for (i, seg) in segments.iter().enumerate() {
        // `fps=` FIRST pins VFR onto the CFR grid so start_frame/end_frame match the timeline exactly.
        g.push_str(&format!(
            "[0:v]fps={rate},trim=start_frame={}:end_frame={},setpts=PTS-STARTPTS[v{i}];",
            seg.start_frame, seg.end_frame
        ));
        if has_audio {
            // Audio is cut at the SAME frame positions in integer samples, so the two spans are equal by construction.
            g.push_str(&format!(
                "[0:a]atrim=start_sample={}:end_sample={},asetpts=PTS-STARTPTS[a{i}];",
                seg.start_sample(sample_rate, fps),
                seg.end_sample(sample_rate, fps)
            ));
        }
    }

    let n = segments.len();
    for i in 0..n {
        g.push_str(&format!("[v{i}]"));
        if has_audio {
            g.push_str(&format!("[a{i}]"));
        }
    }

    if has_audio {
        match loudnorm {
            // concat's audio output can't be re-used as a filter input, so route it through an intermediate label before loudnorm.
            Some(ln) => g.push_str(&format!("concat=n={n}:v=1:a=1[v][actmp];[actmp]{ln}[a]")),
            None => g.push_str(&format!("concat=n={n}:v=1:a=1[v][a]")),
        }
    } else {
        g.push_str(&format!("concat=n={n}:v=1:a=0[v]"));
    }
    g
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(sf: u64, ef: u64) -> Segment {
        Segment { start_frame: sf, end_frame: ef }
    }

    #[test]
    fn concat_list_has_header_and_segments() {
        let fps = Rational { num: 30, den: 1 };
        let g = build_concat_list(&[seg(0, 90), seg(150, 300)], fps, "/tmp/in.mp4");
        assert!(g.starts_with("ffconcat version 1.0\n"));
        assert!(g.contains("file '/tmp/in.mp4'\ninpoint 0.000000\noutpoint 3.000000\n"));
        assert!(g.contains("file '/tmp/in.mp4'\ninpoint 5.000000\noutpoint 10.000000\n"));
    }

    #[test]
    fn ntsc_rate_boundaries_in_seconds() {
        let fps = Rational { num: 30000, den: 1001 };
        let g = build_concat_list(&[seg(0, 30)], fps, "/tmp/in.mp4");
        // 30 frames at 30000/1001 ≈ 1.001 s
        assert!(g.contains("outpoint 1.001000"));
    }

    #[test]
    fn path_with_quote_is_escaped() {
        let fps = Rational { num: 30, den: 1 };
        let g = build_concat_list(&[seg(0, 30)], fps, "/tmp/a'b.mp4");
        assert!(g.contains("file '/tmp/a'\\''b.mp4'"));
    }

    #[test]
    fn trim_filter_has_branches_and_concat() {
        let fps = Rational { num: 30, den: 1 };
        let g = build_trim_concat_filter(&[seg(0, 90), seg(150, 300)], fps, None, true, 48000);
        assert!(g.contains("[0:v]fps=30/1,trim=start_frame=0:end_frame=90,setpts=PTS-STARTPTS[v0];"));
        assert!(g.contains("[0:a]atrim=start_sample=240000:end_sample=480000,asetpts=PTS-STARTPTS[a1];"));
        assert!(g.ends_with("[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]"));
    }

    #[test]
    fn trim_filter_uses_frame_and_sample_indices_not_seconds() {
        // NTSC: at 30000/1001 a 6-decimal second would round a frame off.
        let fps = Rational { num: 30000, den: 1001 };
        let g = build_trim_concat_filter(&[seg(0, 30)], fps, None, true, 48000);
        assert!(g.contains("fps=30000/1001,trim=start_frame=0:end_frame=30"));
        assert!(g.contains("atrim=start_sample=0:end_sample=48048")); // 30 × 1601.6
        assert!(!g.contains("start="), "no float seconds in the graph: {g}");
    }

    #[test]
    fn trim_filter_appends_loudnorm_via_intermediate() {
        let fps = Rational { num: 30, den: 1 };
        let g = build_trim_concat_filter(&[seg(0, 90)], fps, Some("loudnorm=I=-16,aresample=48000"), true, 48000);
        assert!(g.ends_with("concat=n=1:v=1:a=1[v][actmp];[actmp]loudnorm=I=-16,aresample=48000[a]"));
    }

    #[test]
    fn trim_filter_video_only_when_no_audio() {
        let fps = Rational { num: 30, den: 1 };
        let g = build_trim_concat_filter(&[seg(0, 90)], fps, None, false, 48000);
        assert!(!g.contains("atrim"));
        assert!(g.ends_with("[v0]concat=n=1:v=1:a=0[v]"));
    }

    #[test]
    fn audio_filter_retimes_and_appends_loudnorm() {
        assert_eq!(
            build_audio_filter(None),
            "aresample=async=1:first_pts=0,asetpts=N/SR/TB"
        );
        let f = build_audio_filter(Some("loudnorm=I=-16,aresample=48000"));
        assert_eq!(
            f,
            "aresample=async=1:first_pts=0,asetpts=N/SR/TB,loudnorm=I=-16,aresample=48000"
        );
    }
}
