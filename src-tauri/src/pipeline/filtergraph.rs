use crate::domain::media::Rational;
use crate::pipeline::timeline::Segment;

/// Build a concat-demuxer script that keeps every speech segment and drops the
/// silence between them. Pure — takes the fully-decided timeline and the input
/// path, returns the `ffconcat` text (written to a script file by the runner and
/// fed to ffmpeg as `-f concat -safe 0 -i <file>`).
///
/// Why the concat DEMUXER instead of a `filter_complex`:
///   - A per-segment `trim`/`atrim`→`concat` FILTER graph forces ffmpeg to split
///     every decoded frame into N branches — O(frames × segments), which turns
///     into hours of 100% CPU past a few hundred cuts (GPU can't help; the wall
///     is the filtergraph, not the encoder).
///   - A single `select`/`aselect` predicate over all ranges overflows ffmpeg's
///     expression parser ("Cannot allocate memory") past ~500 terms.
///   - The concat demuxer seeks the source per segment via `inpoint`/`outpoint`,
///     decoding ONLY the kept spans and feeding the encoder one clean stream. It
///     scales to thousands of segments (it's just a text list) and lets the
///     hardware encoder run at full speed.
///
/// Each kept segment becomes:
///   file '<input>'
///   inpoint <start>
///   outpoint <end>
///
/// Segment second-spans come from the frame indices, so what we cut matches the
/// timeline the rest of the pipeline computed. Audio timestamps from the demuxer
/// are not contiguous across segment joins; the audio filter (see
/// [`build_audio_filter`]) re-times them so A/V stays in sync.
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

/// The audio filter chain applied on top of the concat-demuxer output. The
/// concat demuxer joins per-segment audio with non-monotonic timestamps (each
/// join restarts the source clock), which desyncs A/V and floods the muxer with
/// "Non-monotonic DTS" corrections. `aresample=async=1:first_pts=0` absorbs the
/// boundary fractional samples and `asetpts=N/SR/TB` renumbers every sample onto
/// one contiguous clock — together they close the gaps cleanly. Any loudnorm
/// filter (which carries its own trailing `aresample` back to the source rate)
/// is appended after.
pub fn build_audio_filter(loudnorm: Option<&str>) -> String {
    let retime = "aresample=async=1:first_pts=0,asetpts=N/SR/TB";
    match loudnorm {
        Some(ln) => format!("{retime},{ln}"),
        None => retime.to_string(),
    }
}

/// Wrap a path for the concat demuxer's `file` directive: single-quote it and
/// escape any embedded single quotes as `'\''`.
fn escape_concat_path(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
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
