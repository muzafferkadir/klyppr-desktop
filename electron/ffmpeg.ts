import ffmpeg from 'fluent-ffmpeg';
import { ipcMain, app, BrowserWindow, dialog } from 'electron';
import { join, dirname, parse } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { EventEmitter } from 'events';
import isDev from 'electron-is-dev';

// FFmpeg types
interface FFmpegProgress {
  frames: number;
  currentFps?: number;
  currentKbps?: number;
  targetSize?: number;
  timemark?: string;
  percent?: number;
}

interface FFmpegCodecData {
  format: {
    duration?: number;
    size?: string;
    bit_rate?: string;
  };
  frames?: string;
}

export interface SilentSegment {
  start: number;
  end: number;
}

// Add type declarations for fluent-ffmpeg
declare module 'fluent-ffmpeg' {
  interface FfmpegCommand {
    on(event: 'start', callback: (command: string) => void): FfmpegCommand;
    on(event: 'codecData', callback: (data: FFmpegCodecData) => void): FfmpegCommand;
    on(event: 'progress', callback: (progress: FFmpegProgress) => void): FfmpegCommand;
    on(event: 'end', callback: () => void): FfmpegCommand;
    on(event: 'error', callback: (err: Error) => void): FfmpegCommand;
    on(event: 'stderr', callback: (stderrLine: string) => void): FfmpegCommand;
  }
}

export class FFmpegService extends EventEmitter {
  private static instance: FFmpegService;
  private mainWindow: BrowserWindow;

  private constructor(mainWindow: BrowserWindow) {
    super();
    this.mainWindow = mainWindow;
    this.setupIpcHandlers();
    this.setupFFmpegPath();
  }

  public static getInstance(mainWindow?: BrowserWindow): FFmpegService {
    if (!FFmpegService.instance && mainWindow) {
      FFmpegService.instance = new FFmpegService(mainWindow);
    }
    return FFmpegService.instance;
  }

  private setupIpcHandlers() {
    ipcMain.handle('detect-silence', async (_, { filePath, threshold, minDuration }) => {
      return await this.detectSilence(filePath, threshold, minDuration);
    });

    ipcMain.handle('get-save-file-path', async (_, filePath) => {
      return await this.getSaveFilePath(filePath);
    });

    ipcMain.handle('trim-silence', async (_, { filePath, segments, padding, threadCount, outputPath }) => {
      return await this.trimSilence(filePath, segments, padding, threadCount, outputPath);
    });
  }

  private setupFFmpegPath() {
    const ffmpegPath = isDev
      ? join(process.cwd(), 'public', 'ffmpeg')
      : join(process.resourcesPath, 'ffmpeg');
    
    const ffprobePath = isDev
      ? join(process.cwd(), 'public', 'ffprobe')
      : join(process.resourcesPath, 'ffprobe');

    if (!isDev && process.platform !== 'win32') {
      require('child_process').execSync(`chmod +x "${ffmpegPath}"`);
      require('child_process').execSync(`chmod +x "${ffprobePath}"`);
    }

    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);
  }

  private sendProgress(value: number) {
    if (this.mainWindow?.webContents) {
      const clampedValue = Math.min(100, Math.max(0, value));
      const progress = clampedValue.toFixed(2);
      try {
        // Cast to any to bypass TypeScript type checking
        (this.mainWindow.webContents as any).send('progress', progress);
      } catch (error) {
        console.error('[FFmpeg] Error sending progress:', error);
      }
    }
  }

  private async getSaveFilePath(originalPath: string): Promise<string | null> {
    const { name } = parse(originalPath);
    const defaultPath = join(app.getPath('downloads'), `${name}_trimmed.mp4`);
    
    const result = await dialog.showSaveDialog(this.mainWindow, {
      title: 'Save Trimmed Video',
      defaultPath,
      filters: [
        { name: 'MP4 Video', extensions: ['mp4'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    return result.canceled ? null : result.filePath;
  }

  public async detectSilence(
    inputPath: string,
    threshold: number = -45,
    minDuration: number = 0.6
  ): Promise<SilentSegment[]> {
    console.log(`[FFmpeg] Starting silence detection for: ${inputPath}`);
    console.log(`[FFmpeg] Parameters - threshold: ${threshold}dB, minDuration: ${minDuration}s`);

    return new Promise((resolve, reject) => {
      const silentSegments: SilentSegment[] = [];
      let currentSegment: Partial<SilentSegment> = {};
      let totalDuration = 0;
      let currentTime = 0;
      let lastProgressTime = Date.now();

      ffmpeg(inputPath)
        .audioFilters(`silencedetect=n=${threshold}dB:d=${minDuration}`)
        .format('null')
        .on('start', (command) => {
          console.log(`[FFmpeg] Executing command: ${command}`);
          this.sendProgress(0);
        })
        .on('codecData', (data: FFmpegCodecData) => {
          console.log(`[FFmpeg] Codec data received:`, data);
          if (data.format?.duration) {
            totalDuration = parseFloat(data.format.duration.toString());
            console.log(`[FFmpeg] Total duration: ${totalDuration}s`);
          }
        })
        .on('stderr', (stderrLine: string) => {
          const startMatch = stderrLine.match(/silence_start: ([\d.]+)/);
          const endMatch = stderrLine.match(/silence_end: ([\d.]+)/);
          const timeMatch = stderrLine.match(/time=(\d+:\d+:\d+.\d+)/);

          if (startMatch) {
            currentSegment.start = parseFloat(startMatch[1]);
            console.log(`[FFmpeg] Silence detected at: ${currentSegment.start}s`);
          }
          if (endMatch) {
            currentSegment.end = parseFloat(endMatch[1]);
            console.log(`[FFmpeg] Silence ended at: ${currentSegment.end}s`);
            if (currentSegment.start !== undefined && currentSegment.end !== undefined) {
              silentSegments.push(currentSegment as SilentSegment);
              console.log(`[FFmpeg] Added silent segment: ${currentSegment.start}s - ${currentSegment.end}s`);
              currentSegment = {};
            }
          }

          if (timeMatch) {
            const [hours, minutes, seconds] = timeMatch[1].split(':').map(parseFloat);
            currentTime = hours * 3600 + minutes * 60 + seconds;
            
            // Only update progress every 100ms to avoid flooding
            const now = Date.now();
            if (now - lastProgressTime >= 100) {
              const progress = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;
              this.sendProgress(Math.min(progress, 99)); // Never send 100% until actually complete
              lastProgressTime = now;
              console.log(`[FFmpeg] Progress: ${progress.toFixed(2)}% (${currentTime.toFixed(2)}s / ${totalDuration.toFixed(2)}s)`);
            }
          }
        })
        .on('end', () => {
          console.log(`[FFmpeg] Silence detection completed. Found ${silentSegments.length} silent segments.`);
          this.sendProgress(100);
          resolve(silentSegments);
        })
        .on('error', (err) => {
          console.error(`[FFmpeg] Error during silence detection:`, err);
          reject(err);
        })
        .output('/dev/null')
        .run();
    });
  }

  private async getVideoDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration || 0);
      });
    });
  }

  private async getNonSilentSegments(
    silentSegments: SilentSegment[],
    filePath: string,
    padding: number = 0.05
  ): Promise<SilentSegment[]> {
    const nonSilentSegments: SilentSegment[] = [];
    let currentTime = 0;
    const duration = await this.getVideoDuration(filePath);

    for (const segment of silentSegments) {
      if (segment.start > currentTime) {
        nonSilentSegments.push({
          start: Math.max(0, currentTime - padding),
          end: Math.min(segment.start + padding, segment.end)
        });
      }
      currentTime = segment.end;
    }

    if (currentTime < duration) {
      nonSilentSegments.push({
        start: Math.max(0, currentTime - padding),
        end: duration
      });
    }

    return nonSilentSegments;
  }

  public async trimSilence(
    filePath: string,
    silentSegments: SilentSegment[],
    padding: number = 0.05,
    threadCount: number = 4,
    outputPath: string
  ): Promise<string> {
    console.log(`[FFmpeg] Starting silence trimming for: ${filePath}`);
    console.log(`[FFmpeg] Parameters - padding: ${padding}s, threadCount: ${threadCount}`);
    console.log(`[FFmpeg] Output path: ${outputPath}`);

    if (!silentSegments?.length) {
      console.log(`[FFmpeg] No silent segments found, skipping trim`);
      throw new Error('No segments provided');
    }

    const nonSilentSegments = await this.getNonSilentSegments(silentSegments, filePath, padding);
    console.log(`[FFmpeg] Non-silent segments:`, nonSilentSegments);

    if (!nonSilentSegments.length) {
      console.log(`[FFmpeg] No non-silent segments found`);
      throw new Error('No non-silent segments found');
    }

    const dir = dirname(outputPath);
    if (!existsSync(dir)) {
      console.log(`[FFmpeg] Creating output directory: ${dir}`);
      mkdirSync(dir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      let totalFrames = 1000;
      let processedFrames = 0;
      let lastProgress = 0;
      let lastProgressTime = Date.now();

      const filters = nonSilentSegments.map((segment, i) => [
        `[0:v]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS[v${i}]`,
        `[0:a]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS[a${i}]`
      ]).flat();

      const segments = nonSilentSegments.map((_, i) => `[v${i}][a${i}]`).join('');
      filters.push(`${segments}concat=n=${nonSilentSegments.length}:v=1:a=1[outv][outa]`);

      console.log(`[FFmpeg] Complex filter:`, filters);

      ffmpeg(filePath)
        .outputOptions(['-threads', threadCount.toString()])
        .complexFilter(filters, ['outv', 'outa'])
        .on('start', (command) => {
          console.log(`[FFmpeg] Executing trim command: ${command}`);
          this.sendProgress(0);
        })
        .on('codecData', (data: FFmpegCodecData) => {
          console.log(`[FFmpeg] Codec data received:`, data);
          if (data.frames) {
            totalFrames = parseInt(data.frames, 10);
            console.log(`[FFmpeg] Total frames: ${totalFrames}`);
          }
        })
        .on('progress', (progress: FFmpegProgress) => {
          if (progress.frames) {
            processedFrames = progress.frames;
            const percent = Math.min((processedFrames / totalFrames) * 100, 99); // Never send 100% until actually complete

            // Only update progress every 100ms to avoid flooding
            const now = Date.now();
            if (Math.abs(percent - lastProgress) >= 1 && now - lastProgressTime >= 100) {
              lastProgress = percent;
              lastProgressTime = now;
              this.sendProgress(percent);
              console.log(`[FFmpeg] Trim progress: ${percent.toFixed(2)}% (${processedFrames}/${totalFrames} frames)`);
            }
          }
        })
        .on('end', () => {
          console.log(`[FFmpeg] Trim completed successfully`);
          this.sendProgress(100);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error(`[FFmpeg] Error during trim:`, err);
          reject(err);
        })
        .save(outputPath);
    });
  }
}