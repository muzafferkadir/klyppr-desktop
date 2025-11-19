# Klyppr Desktop

> **📋 Latest Updates (v1.2.0):** Major improvements including audio normalization, video quality presets, improved UI/UX, and code refactoring

This is the desktop version of [Klyppr](https://github.com/muzafferkadir/klyppr), a tool for editing video silence.

## Features

- Detect and remove silent parts from videos
- **Audio normalization** - YouTube standard -16 LUFS loudness normalization
- **Video quality presets** - Choose between Fast, Medium, and High quality settings
- Adjustable silence threshold (dB)
- Configurable minimum silence duration
- Padding duration control for smooth transitions
- User-friendly desktop interface with improved layout
- Real-time progress tracking with accurate percentage display
- Supports multiple video formats (mp4, avi, mov, mkv)

## Installation

1. Download the latest release for your operating system

[MacOS (arm64)](https://github.com/muzafferkadir/klyppr-desktop/releases/download/v0.1.0/Klyppr-1.1.0-arm64.dmg)

[Windows (x64)](https://github.com/muzafferkadir/klyppr-desktop/releases/download/v0.1.0/Klyppr.Setup.1.1.0.exe)

3. Install the application
4. Launch Klyppr Desktop

## Development Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Set up FFmpeg binaries:
   - Create the following directory structure:
     ```
     bin/
     ├── mac/
     │   ├── ffmpeg
     │   └── ffprobe
     └── win/
         ├── ffmpeg.exe
         └── ffprobe.exe
     ```
   - Download FFmpeg binaries and Place the binaries in their respective directories as shown above
4. Run the development server:
   ```bash
   npm run start
   ```

## Building

Build for specific platforms:

```bash
# For macOS
npm run build:mac

# For Windows 64-bit
npm run build:win64

# For Windows 32-bit
npm run build:win32
```

The built applications will be available in the `dist` directory.

## Usage

1. Click "Browse" to select your input video file
2. Choose an output folder for the processed video
3. Select a quality preset (optional):
   - **Fast** - Faster processing, lower quality
   - **Medium** - Balanced quality and speed (default)
   - **High** - Best quality, slower processing
   - **Aggressive** - Tight detection for minimal silence
4. Adjust advanced settings (optional):
   - Silence Threshold (dB): Default -35dB
   - Minimum Silence Duration (seconds): Default 0.5s
   - Padding Duration (seconds): Default 0.05s
   - Enable audio normalization (YouTube standard -16 LUFS)
5. Click "Start Processing" to begin
6. Monitor the progress in real-time with detailed logs
7. Find your processed video in the selected output folder

## What's New in v1.2.0

- ✨ **Audio Normalization** - Automatically normalize audio to YouTube standard (-16 LUFS)
- 🎨 **Video Quality Presets** - Choose from Fast, Medium, High, or Aggressive presets
- 🚀 **Performance Improvements** - Optimized silence detection using audio-only processing
- 🔧 **Code Refactoring** - Improved code organization following DRY and SOLID principles
- 🎯 **Better Progress Tracking** - Accurate progress percentage calculations
- 💅 **UI/UX Enhancements** - Improved layout, standardized spacing, and better responsive design
- 🐛 **Bug Fixes** - Fixed Windows command line length issues with long select filters

## Development

This is an Electron-based application using:
- Electron
- FFmpeg for video processing
- Node.js

## Contributors

Special thanks to [@parsherr](https://github.com/parsherr) for their contributions to this project!

## Related Projects

- [Klyppr Web Version](https://github.com/muzafferkadir/klyppr) - The web-based version of Klyppr

## License

MIT License 
