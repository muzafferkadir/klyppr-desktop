use crate::domain::media::Rational;
use crate::pipeline::timeline::Segment;

/// Build the filter_complex graph that trims each speech segment and concats
/// them back together. Pure — takes the fully-decided timeline and an optional
/// loudnorm filter string, returns the graph text (written to a script file by
/// the runner, since 400+ segments overflow the command line).
///
/// Per segment:
///   [0:v]fps=<rational>,trim=start=..:end=..,setpts=PTS-STARTPTS[vN]
///   [0:a]atrim=start=..:end=..,asetpts=PTS-STARTPTS[aN]
///
/// `fps=` first pins a (possibly VFR) source to a constant grid BEFORE trimming,
/// so the snapped cut points land on real frames. Video and audio cut times are
/// both computed from the segment's frame indices, so they stay the same length.
pub fn build_filter_graph(
    segments: &[Segment],
    fps: Rational,
    loudnorm: Option<&str>,
) -> String {
    let rate = fps.as_ffmpeg();
    let mut parts: Vec<String> = Vec::with_capacity(segments.len());

    for (i, seg) in segments.iter().enumerate() {
        let start = seg.start_secs(fps);
        let end = seg.end_secs(fps);
        parts.push(format!(
            "[0:v]fps={rate},trim=start={start:.6}:end={end:.6},setpts=PTS-STARTPTS[v{i}];\
             [0:a]atrim=start={start:.6}:end={end:.6},asetpts=PTS-STARTPTS[a{i}]"
        ));
    }

    let concat_inputs: String = (0..segments.len()).map(|i| format!("[v{i}][a{i}]")).collect();
    let mut graph = format!(
        "{};{}concat=n={}:v=1:a=1",
        parts.join(";"),
        concat_inputs,
        segments.len()
    );

    match loudnorm {
        Some(ln) => graph.push_str(&format!("[tmpv][tmpa];[tmpv]copy[outv];[tmpa]{ln}[outa]")),
        None => graph.push_str("[outv][outa]"),
    }

    graph
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(sf: u64, ef: u64) -> Segment {
        Segment { start_frame: sf, end_frame: ef }
    }

    #[test]
    fn two_segments_no_loudnorm() {
        let fps = Rational { num: 30, den: 1 };
        let g = build_filter_graph(&[seg(0, 90), seg(150, 300)], fps, None);
        assert!(g.contains("[0:v]fps=30/1,trim=start=0.000000:end=3.000000"));
        assert!(g.contains("atrim=start=5.000000:end=10.000000"));
        assert!(g.contains("concat=n=2:v=1:a=1[outv][outa]"));
        assert!(!g.contains("loudnorm"));
    }

    #[test]
    fn loudnorm_routes_audio_through_filter() {
        let fps = Rational { num: 30, den: 1 };
        let g = build_filter_graph(&[seg(0, 30)], fps, Some("loudnorm=I=-16"));
        assert!(g.contains("[tmpv]copy[outv]"));
        assert!(g.contains("[tmpa]loudnorm=I=-16[outa]"));
    }

    #[test]
    fn ntsc_rate_written_as_exact_rational() {
        let fps = Rational { num: 30000, den: 1001 };
        let g = build_filter_graph(&[seg(0, 30)], fps, None);
        assert!(g.contains("fps=30000/1001"));
    }
}
