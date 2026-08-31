# Klyppr Desktop

> **📋 Latest (v3.1.0):** Rewritten in **Tauri 2 + Rust + Svelte 5**. Zoomable **waveform timeline** with live cut preview, terminal one-liner install (no App Store, no signing prompts), app-managed FFmpeg, and a self-updating build.

Automatic video **silence cutter** — detects quiet gaps and removes them, keeping your source format. Desktop version of [Klyppr](https://github.com/muzafferkadir/klyppr).

## Install

### 🌐 One-click page

**[install.klyppr — kurulum sayfası →](https://muzafferkadir.github.io/klyppr-desktop/)** (copy-paste the command for your OS)

### 🍎 macOS (Apple Silicon & Intel)

```sh
curl -fsSL https://raw.githubusercontent.com/muzafferkadir/klyppr-desktop/main/install.sh | bash
```

Run it in **Terminal** (`⌘Space` → "Terminal"). Downloads the latest `.dmg`, installs **Klyppr.app** to `/Applications`, and clears quarantine so it opens without a Gatekeeper prompt. FFmpeg is fetched by the app on first launch.

Homebrew (via tap):

```sh
brew install --cask muzafferkadir/tap/klyppr
```

### 🪟 Windows

```powershell
irm https://raw.githubusercontent.com/muzafferkadir/klyppr-desktop/main/install.ps1 | iex
```

Run it in **PowerShell** (Start → "PowerShell"). Downloads and runs the latest signed NSIS installer.

### ⬇️ Manual

Grab a `.dmg` / `.exe` from the **[latest release](https://github.com/muzafferkadir/klyppr-desktop/releases/latest)**.

## Features

- **Zoomable waveform timeline** — see loudness, detected silence/cut regions, and a live playhead; scrub by clicking. Tune Threshold / Min. Silence / Padding and the cuts update instantly.
- **Cut preview** — video playback skips the silence, so what you see is what you export.
- Native **macOS** look (vibrancy, hidden-inset title bar) and a **Windows** build.
- **GPU acceleration** — VideoToolbox / NVENC / QSV / AMF (auto-detected).
- **Audio normalization** — YouTube-standard −16 LUFS.
- **Quality presets** — Lossless / High / Medium / Fast, format-preserving output.
- **Session persistence** — reopens your last video and settings; warns before quitting mid-process.
- **Self-updating** — signed updater checks GitHub Releases.
- App-managed **FFmpeg** — no system FFmpeg required, downloaded on first run.

## Usage

1. Drop (or select) a video — it's analyzed automatically.
2. Pick a preset (**Recommended** / **Aggressive**) or tune Advanced Settings.
3. Watch the timeline: cut regions and the "keep" duration update live.
4. **Start Processing** (Cancel any time). Output lands in your chosen folder.

## Development

```bash
pnpm install
pnpm tauri dev     # run the app
pnpm check         # type-check
```

Frontend: Svelte 5 + Vite (`src/`). Backend: Rust (`src-tauri/`). FFmpeg is downloaded at runtime — nothing to vendor.

## Release

Tag a version and CI builds + drafts a GitHub Release for macOS (arm64 + x64) and Windows:

```bash
git tag v3.1.0 && git push --tags
```

Requires repo secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (see `.github/workflows/release.yml`).

## Tech

Tauri 2 · Rust · Svelte 5 · Vite · FFmpeg (app-managed)

## Contributors

Special thanks to [@parsherr](https://github.com/parsherr).

## Related

- [Klyppr Web](https://github.com/muzafferkadir/klyppr) — the web version

## License

MIT License — see [LICENSE](LICENSE).
