import ffmpeg from 'fluent-ffmpeg';
import { ipcMain, app, BrowserWindow } from 'electron';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { EventEmitter } from 'events';

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

export interface SilentSegment {
  start: number;
  end: number;
}

// Add type definition for FFmpeg progress data
interface FFmpegProgress {
  frames: number;
  currentFps: number;
  currentKbps: number;
  targetSize: number;
  timemark: string;
  percent: number;
}

// Add type definition for FFmpeg codec data
interface FFmpegCodecData {
  format: string;
  audio: string;
  audio_details: string[];
  video: string;
  video_details: string[];
  duration: string;
  frames?: string;
}

export class FFmpegService extends EventEmitter {
  private static instance: FFmpegService;
  private mainWindow: BrowserWindow;

  private constructor(mainWindow: BrowserWindow) {
    super();
    this.mainWindow = mainWindow;
    this.setupIpcHandlers();
  }

  public static getInstance(mainWindow?: BrowserWindow): FFmpegService {
    if (!FFmpegService.instance && mainWindow) {
      FFmpegService.instance = new FFmpegService(mainWindow);
    }
    return FFmpegService.instance;
  }

  private setupIpcHandlers() {
    ipcMain.handle('detect-silence', async (_, { filePath, threshold, minDuration }) => {
      try {
        return await this.detectSilence(filePath, threshold, minDuration);
      } catch (error) {
        console.error('Error detecting silence:', error);
        throw error;
      }
    });

    ipcMain.handle('trim-silence', async (_, { filePath, segments, padding }) => {
      try {
        return await this.trimSilence(filePath, segments, padding);
      } catch (error) {
        console.error('Error trimming silence:', error);
        throw error;
      }
    });
  }

  public async detectSilence(
    inputPath: string,
    threshold: number = -45,
    minDuration: number = 0.6
  ): Promise<SilentSegment[]> {
    return new Promise((resolve, reject) => {
      const silenceStartRegex = /silence_start: ([\d.]+)/;
      const silenceEndRegex = /silence_end: ([\d.]+)/;
      const silentSegments: SilentSegment[] = [];
      let currentSegment: Partial<SilentSegment> = {};

      ffmpeg(inputPath)
        .audioFilters(`silencedetect=n=${threshold}dB:d=${minDuration}`)
        .format('null')
        .on('error', (err: Error) => reject(err))
        .on('stderr', (stderrLine: string) => {
          const startMatch = stderrLine.match(silenceStartRegex);
          const endMatch = stderrLine.match(silenceEndRegex);

          if (startMatch) {
            currentSegment.start = parseFloat(startMatch[1]);
          }
          if (endMatch) {
            currentSegment.end = parseFloat(endMatch[1]);
            if (currentSegment.start !== undefined && currentSegment.end !== undefined) {
              silentSegments.push(currentSegment as SilentSegment);
              currentSegment = {};
            }
          }
        })
        .on('end', () => resolve(silentSegments))
        .output('/dev/null')
        .run();
    });
  }

  private async getVideoDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          console.error('Error getting duration:', err);
          reject(err);
          return;
        }
        resolve(metadata.format.duration || 999999);
      });
    });
  }

  private async getNonSilentSegments(silentSegments: SilentSegment[], filePath: string, padding: number = 0.05): Promise<SilentSegment[]> {
    const nonSilentSegments: SilentSegment[] = [];
    let currentTime = 0;

    for (const segment of silentSegments) {
      if (segment.start > currentTime) {
        nonSilentSegments.push({
          start: Math.max(0, currentTime - padding),
          end: Math.min(segment.start + padding, segment.end)
        });
      }
      currentTime = segment.end;
    }

    // Add final non-silent segment if needed
    const duration = await this.getVideoDuration(filePath);
    if (currentTime < duration) {
      nonSilentSegments.push({
        start: Math.max(0, currentTime - padding),
        end: duration
      });
    }

    return nonSilentSegments;
  }

  private getOutputPath(filePath: string): string {
    const timestamp = Date.now();
    const platform = process.platform;
    let outputPath: string;

    switch (platform) {
      case 'darwin':
        // macOS: Downloads folder
        outputPath = join(app.getPath('downloads'), `trimmed_${timestamp}.mp4`);
        break;
      case 'win32':
        // Windows: Videos folder
        outputPath = join(app.getPath('videos'), `trimmed_${timestamp}.mp4`);
        break;
      default:
        // Linux and others: Downloads folder
        outputPath = join(app.getPath('downloads'), `trimmed_${timestamp}.mp4`);
    }

    // Ensure the directory exists
    const dir = dirname(outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    return outputPath;
  }

  public async trimSilence(
    filePath: string,
    silentSegments: SilentSegment[],
    padding: number = 0.05
  ): Promise<string> {
    if (!silentSegments || silentSegments.length === 0) {
      throw new Error('No segments provided');
    }

    // Get non-silent segments
    const nonSilentSegments = await this.getNonSilentSegments(silentSegments, filePath, padding);
    if (nonSilentSegments.length === 0) {
      throw new Error('No non-silent segments found');
    }

    const outputPath = this.getOutputPath(filePath);
    console.log('Output path:', outputPath);

    // Ensure output directory exists
    const dir = dirname(outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      let totalFrames = 0;
      let processedFrames = 0;

      // Create filter complex command
      const filters: string[] = [];
      
      // Add segment filters for non-silent parts
      nonSilentSegments.forEach((segment, i) => {
        filters.push(
          `[0:v]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS[v${i}]`,
          `[0:a]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS[a${i}]`
        );
      });

      // Add concat filters
      const videoInputs = nonSilentSegments.map((_, i) => `[v${i}]`).join('');
      const audioInputs = nonSilentSegments.map((_, i) => `[a${i}]`).join('');
      
      filters.push(
        `${videoInputs}concat=n=${nonSilentSegments.length}:v=1:a=0[vout]`,
        `${audioInputs}concat=n=${nonSilentSegments.length}:v=0:a=1[aout]`
      );

      console.log('Using non-silent segments:', nonSilentSegments);
      console.log('Filter complex:', filters.join(';'));

      ffmpeg(filePath)
        .on('start', (command) => {
          console.log('FFmpeg command:', command);
        })
        .on('codecData', (data: FFmpegCodecData) => {
          totalFrames = parseInt(data.frames || '1000');
          console.log('Total frames:', totalFrames);
        })
        .on('progress', (progress: FFmpegProgress) => {
          processedFrames = progress.frames || 0;
          const percent = Math.min(Math.round((processedFrames / totalFrames) * 100), 100);
          console.log('Progress:', percent + '%');
          if (this.mainWindow?.webContents) {
            this.mainWindow.webContents.send('progress', percent);
          }
        })
        .on('end', () => {
          console.log('Trimming complete');
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          reject(err);
        })
        .complexFilter(filters)
        .outputOptions([
          '-map', '[vout]',
          '-map', '[aout]',
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-movflags', '+faststart',
          '-y'
        ])
        .save(outputPath);
    });
  }
} 