# Klyppr Desktop

> **📋 Latest (v2.0.0):** Windows build, native macOS UI, a new brand logo, format-preserving output (keeps your source codec / pixel format / audio), GPU acceleration for every quality preset, and a bundled static FFmpeg so it runs anywhere.

This is the desktop version of [Klyppr](https://github.com/muzafferkadir/klyppr), a tool for editing video silence.

## Features

- Detect and remove silent parts from videos
- **Native macOS look** — vibrancy, native window (hidden-inset title bar), grouped cards, system controls
- **GPU hardware acceleration** — auto-detected VideoToolbox (macOS) / NVENC / QSV / AMF (off by default)
- **Two-pass audio normalization** — YouTube-standard -16 LUFS
- **Video quality presets** — Lossless, High, Medium, Fast
- **Cancel any time** — stop processing mid-run
- Drag & drop input, adjustable silence threshold / min duration / padding
- Real-time progress with ETA, MP4-compatible output (`yuv420p`, AAC, faststart)
- Bundled **static FFmpeg** — no system FFmpeg required
- Supports many formats (mp4, mov, mkv, avi, webm, and more)

## Installation

**[⬇️ Download the latest release](https://github.com/muzafferkadir/klyppr-desktop/releases/latest)**

### macOS (app not signed)

1. Move **Klyppr** to your **Applications** folder.
2. If macOS says the app "is damaged" or is from an unidentified developer:
   - **System Settings → Privacy & Security → Open Anyway**, or run:
     ```sh
     xattr -rd com.apple.quarantine /Applications/Klyppr.app
     ```
3. Launch Klyppr.

## Usage

1. Select (or drag & drop) your input video
2. Choose an output folder
3. Pick a preset — **Recommended** or **Aggressive** — or tune Advanced Settings:
   - Silence Threshold (dB), Min. Silence (sec), Padding (sec)
   - Video Quality: Lossless / High / Medium / Fast
   - Normalize Audio (-16 LUFS), GPU Acceleration (if available)
4. Click **Start Processing** (use **Cancel** to stop)
5. Find your processed video in the output folder

## Development

```bash
yarn install
yarn start
```

FFmpeg binaries are **not** committed (see `.gitignore`). Before building, place **static** `ffmpeg`/`ffprobe` in:

```
bin/
├── mac/   (ffmpeg, ffprobe — static arm64)
└── win/   (ffmpeg.exe, ffprobe.exe)
```

> Use **static** builds (e.g. from a trusted source). Dynamically-linked binaries copied from Homebrew will not run on other machines.

## Building

```bash
yarn build:mac      # macOS .dmg
yarn build:win64    # Windows 64-bit
yarn build:win32    # Windows 32-bit
```

Output goes to the `dist` directory.

## What's New in v2.0.0

- 🖥️ **Native macOS UI** — real vibrancy, hidden-inset title bar, grouped cards, native controls; window sized to content and quits on close
- 🪟 **Windows build** — native installer (NSIS) with bundled FFmpeg
- 🎨 **New brand logo** — used in-app (header) and as the app icon
- 🎯 **Format-preserving output** — keeps the source's video codec, pixel format, and audio codec/bitrate (no forced re-format; fixes black-screen output on some players)
- 🎮 **GPU acceleration for every quality preset** — VideoToolbox / NVENC / QSV / AMF (off by default)
- 🔊 **Two-pass loudness normalization** for accurate -16 LUFS
- 🧱 **Bundled static FFmpeg** — runs without a system FFmpeg
- ⚙️ **spawn-based FFmpeg pipeline** (dropped `fluent-ffmpeg`), Cancel button, no-audio handling
- 📱 **Responsive layout** — adapts down to half-screen widths

## Tech

Electron · FFmpeg (invoked directly via `child_process`) · Node.js

## Contributors

Special thanks to [@parsherr](https://github.com/parsherr) for their contributions.

## Related

- [Klyppr Web](https://github.com/muzafferkadir/klyppr) — the web version

## License

MIT License — see [LICENSE](LICENSE).
