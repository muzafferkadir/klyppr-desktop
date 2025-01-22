import ffmpeg from 'fluent-ffmpeg';
import { ipcMain, app } from 'electron';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { EventEmitter } from 'events';

export interface SilentSegment {
  start: number;
  end: number;
}

class FFmpegService extends EventEmitter {
  private static instance: FFmpegService;

  private constructor() {
    super();
    this.setupIpcHandlers();
  }

  public static getInstance(): FFmpegService {
    if (!FFmpegService.instance) {
      FFmpegService.instance = new FFmpegService();
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

  private detectSilence(
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

  private getOutputPath(): string {
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

  async trimSilence(filePath: string, segments: SilentSegment[], padding: number = 0.05): Promise<string> {
    if (!segments || segments.length === 0) {
      throw new Error('No segments provided');
    }

    const outputPath = this.getOutputPath();
    console.log('Output path:', outputPath);

    // Get non-silent segments with padding
    const nonSilentSegments = await this.getNonSilentSegments(segments, filePath, padding);
    if (nonSilentSegments.length === 0) {
      throw new Error('No non-silent segments found');
    }

    // Create filter complex command
    const filters = nonSilentSegments.map((segment, i) => {
      return `[0:v]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS[v${i}];` +
             `[0:a]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS[a${i}]`;
    });

    const concatVideo = nonSilentSegments.map((_, i) => `[v${i}]`).join('');
    const concatAudio = nonSilentSegments.map((_, i) => `[a${i}]`).join('');
    
    filters.push(
      `${concatVideo}concat=n=${nonSilentSegments.length}:v=1:a=0[vout]`,
      `${concatAudio}concat=n=${nonSilentSegments.length}:v=0:a=1[aout]`
    );

    return new Promise((resolve, reject) => {
      let totalFrames = 0;
      let processedFrames = 0;

      ffmpeg(filePath)
        .outputOptions([
          '-map', '[vout]',
          '-map', '[aout]',
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-y'
        ])
        .complexFilter(filters.join(';'))
        .on('start', (cmd) => {
          console.log('Started ffmpeg with command:', cmd);
        })
        .on('stderr', (stderrLine) => {
          console.log('Stderr output:', stderrLine);
          
          // Parse total frames
          const durationMatch = stderrLine.match(/Duration: (\d{2}):(\d{2}):(\d{2})/);
          if (durationMatch) {
            const hours = parseInt(durationMatch[1]);
            const minutes = parseInt(durationMatch[2]);
            const seconds = parseInt(durationMatch[3]);
            totalFrames = (hours * 3600 + minutes * 60 + seconds) * 30; // Assuming 30fps
          }

          // Parse current frame
          const frameMatch = stderrLine.match(/frame=\s*(\d+)/);
          if (frameMatch && totalFrames > 0) {
            processedFrames = parseInt(frameMatch[1]);
            const progress = (processedFrames / totalFrames) * 100;
            // Emit progress event
            this.emit('progress', Math.min(progress, 100));
          }
        })
        .on('error', (err) => {
          console.error('Error:', err);
          reject(err);
        })
        .on('end', () => {
          const fileUrl = new URL(`file://${outputPath}`).href;
          resolve(fileUrl);
        })
        .save(outputPath);
    });
  }
}

export const ffmpegService = FFmpegService.getInstance(); 