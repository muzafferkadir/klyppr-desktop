import ffmpeg from 'fluent-ffmpeg';
import { ipcMain, app, BrowserWindow, dialog } from 'electron';
import { join, dirname, parse } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { EventEmitter } from 'events';
import isDev from 'electron-is-dev';

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
  frames?: number;
  currentFps?: number;
  currentKbps?: number;
  targetSize?: number;
  timemark?: string;
  percent?: number;
}

// Add type definition for FFmpeg codec data
interface FFmpegCodecData {
  format: {
    duration?: number;
    size?: string;
    bit_rate?: string;
    filename?: string;
  };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
    nb_frames?: string;
  }>;
  frames?: string;
  audio?: string;
  audio_details?: string[];
  video?: string;
  video_details?: string[];
  duration?: string;
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

  private setupFFmpegPath() {
    const platform = process.platform;
    let ffmpegPath: string;
    let ffprobePath: string;

    if (isDev) {
      // In development, use the binaries from public folder
      ffmpegPath = join(process.cwd(), 'public', 'ffmpeg');
      ffprobePath = join(process.cwd(), 'public', 'ffprobe');
    } else {
      // In production, use the bundled binaries from resources
      ffmpegPath = join(process.resourcesPath, 'ffmpeg');
      ffprobePath = join(process.resourcesPath, 'ffprobe');
    }

    // Add executable permission in production
    if (!isDev && platform !== 'win32') {
      require('child_process').execSync(`chmod +x "${ffmpegPath}"`);
      require('child_process').execSync(`chmod +x "${ffprobePath}"`);
    }

    console.log('Setting FFmpeg path:', ffmpegPath);
    console.log('Setting FFprobe path:', ffprobePath);

    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);
  }

  private async getSaveFilePath(originalPath: string): Promise<string | null> {
    const { name } = parse(originalPath);
    const defaultPath = join(app.getPath('downloads'), `${name}_trimmed.mp4`);
    
    const result = await dialog.showSaveDialog(this.mainWindow, {
      title: 'Save Trimmed Video',
      defaultPath: defaultPath,
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

    // Get save path from user
    const outputPath = await this.getSaveFilePath(filePath);
    if (!outputPath) {
      throw new Error('Operation cancelled by user');
    }

    // Ensure output directory exists
    const dir = dirname(outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      let totalFrames = 1000; // Default value
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

      ffmpeg(filePath)
        .on('start', (command) => {
          console.log('FFmpeg command:', command);
        })
        .on('codecData', (data: FFmpegCodecData) => {
          // Try to get frames from different possible locations
          const frames = data.frames || 
                        data.streams?.[0]?.nb_frames || 
                        '1000';
          totalFrames = parseInt(frames, 10);
        })
        .on('progress', (progress: FFmpegProgress) => {
          processedFrames = progress.frames || 0;
          const percent = Math.min(Math.round((processedFrames / totalFrames) * 100), 100);
          this.emit('progress', percent);
        })
        .on('error', (err) => {
          console.error('Error during processing:', err);
          reject(err);
        })
        .on('end', () => {
          resolve(outputPath);
        })
        .complexFilter(filters, ['vout', 'aout'])
        .save(outputPath);
    });
  }
} 