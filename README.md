# Klyppr Desktop

This is the desktop version of [Klyppr](https://github.com/muzafferkadir/klyppr), a tool for editing video silence.

## Features

- Detect and remove silent parts from videos
- Adjustable silence threshold (dB)
- Configurable minimum silence duration
- Padding duration control for smooth transitions
- User-friendly desktop interface
- Supports multiple video formats (mp4, avi, mov, mkv)

## Installation

1. Download the latest release for your operating system
2. Install the application
3. Launch Klyppr Desktop

## Usage

1. Click "Browse" to select your input video file
2. Choose an output folder for the processed video
3. Adjust the settings (optional):
   - Silence Threshold (dB): Default -45dB
   - Minimum Silence Duration (seconds): Default 0.6s
   - Padding Duration (seconds): Default 0.05s
4. Click "Start Processing" to begin
5. Monitor the progress in real-time
6. Find your processed video in the selected output folder

## Development

This is an Electron-based application using:
- Electron
- FFmpeg for video processing
- Node.js

To run the development version:

```bash
# Install dependencies
npm install

# Run the app
npm start
```

## Related Projects

- [Klyppr Web Version](https://github.com/muzafferkadir/klyppr) - The web-based version of Klyppr

## License

MIT License 