# Klyppr Editor: Zoomable Timeline + Live Preview — Design

Date: 2026-08-31
Status: Approved

## Goal

Turn Klyppr from a one-shot silence-cutter into a small edit view: when a video
is loaded, show a zoomable waveform timeline with the detected silence (cut)
regions, and a video preview that plays the *cut* result (skipping silence). As
the user tweaks dB / min-silence / padding, the cuts recompute live. Cutting is
still fully automatic — no manual segment editing (out of scope).

## Scope

In scope:
- Waveform + loudness visualization of the loaded video's audio.
- Silence/cut regions drawn over the waveform, recomputed live from settings.
- Video preview that skips silence ("cut preview"), CapCut-style.
- Zoom / pan on the timeline.
- Export uses exactly what the timeline shows (preview == output).

Out of scope (YAGNI):
- Manual segment editing (drag/split/trim/reorder, add/remove individual cuts).
- Multi-clip / multi-track editing.
- Toggling between original and cut playback (cut preview only).

## Architecture & data flow

```
Load video → backend analyze_audio (ONCE):
    ffmpeg → mono low-rate PCM → Rust computes:
      peaks[]       (waveform amplitude per bucket)
      envelope_db[] (loudness in dB per ~25ms bucket)
    → frontend { duration, sample_bucket_ms, peaks, envelope_db }

Frontend (from envelope, no ffmpeg, INSTANT):
    compute_silence(envelope_db, threshold_db, min_silence, padding) → ranges[]
    → draw waveform + silence overlay + threshold line + playhead
    slider change → recompute ranges → timeline + preview update live

Export → frontend's ranges passed to start_job
    → backend SKIPS detect_silence, builds the timeline from the given ranges
    → same encode pipeline → "what you see is what you get"
```

The single source of truth for cuts during editing is the frontend's
`compute_silence`. Because export sends those exact ranges to the backend
(rather than letting the backend re-run `silencedetect`), the preview and the
final output are guaranteed identical.

## Backend changes (small, additive)

1. `analyze_audio(input_path) -> AudioAnalysis`
   - `AudioAnalysis { duration: f64, bucket_ms: u32, peaks: Vec<f32>, envelope_db: Vec<f32> }`
   - Runs ffmpeg to decode audio to mono f32 PCM at a low sample rate (e.g. 8 kHz),
     then buckets into ~25 ms windows: `peaks` = max abs amplitude per bucket
     (0..1), `envelope_db` = RMS in dBFS per bucket (negative; −inf floored to a
     sentinel like −90).
   - New module `pipeline/analyze.rs`; does not touch the existing pipeline.
2. `JobRequest` gains `silence_ranges: Option<Vec<[f64; 2]>>`.
   - `Some(ranges)` → orchestrator skips `detect_silence` and feeds the ranges
     straight into `build_timeline` (padding still applied there, as today).
   - `None` → current automatic behavior (backend runs `detect_silence`).
   - This keeps the plain "just Start" flow working unchanged.

## Frontend (the bulk of the work)

- **Editor view**: appears once a video is selected (before that, the current
  simple screen stays). Layout: preview on top, full-width timeline below,
  settings + Export on the side.
- **Timeline** (canvas): waveform (peaks), silence regions as a red overlay, the
  dB threshold as a horizontal line, a playhead, and zoom/pan (wheel = zoom,
  drag = pan). Redraws on zoom/pan and when ranges change.
- **Preview**: `<video>` via Tauri `convertFileSrc`; a `timeupdate` handler
  jumps the current time to the start of the next kept segment when it enters a
  silence range (cut preview). Play/pause + scrub.
- **`compute_silence`**: a pure TS function
  `(envelopeDb, bucketMs, thresholdDb, minSilence, padding) → Range[]`, mirroring
  silencedetect (below-threshold runs of at least `minSilence`, then inset by
  `padding`). Unit tested with a synthetic envelope.
- **State** (Svelte 5 runes): `analysis` (from backend), `settings`, and derived
  `ranges`. The timeline, preview, and Export all read `ranges`.

## Known risks / decisions

- **HEVC / MOV preview in WKWebView**: Safari's engine plays HEVC, but iPhone
  10-bit Dolby Vision MOV may not decode. If the `<video>` fails to load, the
  editor shows "Preview unavailable for this format" and the timeline still works
  fully (analysis + cuts + export are independent of the `<video>` element).
- **Client vs ffmpeg silence parity**: `compute_silence` runs on the 25 ms
  envelope with the same threshold/min-duration logic as silencedetect. Minor
  differences don't matter because the frontend ranges are authoritative at
  export — preview and output use the same ranges.
- **Waveform performance**: peaks are pre-bucketed by the backend; the canvas
  downsamples further to the pixel width at the current zoom, so drawing cost is
  bounded by canvas width, not video length.

## Testing

- Rust: `analyze_audio` bucket math (peaks/RMS on a known PCM slice); `build_timeline`
  already covers the ranges path — add a case where ranges come from the request.
- TS: `compute_silence` against a synthetic envelope (below/above threshold runs,
  min-silence filtering, padding inset, silence at start/end).
