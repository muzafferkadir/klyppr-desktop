import { BrowserWindow, ipcMain, dialog, app, shell } from 'electron';
import ffmpeg from 'fluent-ffmpeg';
import { join, parse } from 'path';
import isDev from 'electron-is-dev';
import os from 'os';

interface SilentSegment {
  start: number;
  end: number;
}

interface FFmpegFormat {
  duration: string;
  size?: string;
  bit_rate?: string;
}

interface FFmpegCodecData {
  format: FFmpegFormat;
  duration?: string;
}

// FFmpeg type declarations
declare module 'fluent-ffmpeg' {
  interface FfmpegCommand {
    on(event: 'start', callback: (commandLine: string) => void): FfmpegCommand;
    on(event: 'codecData', callback: (data: { format: { duration: string } }) => void): FfmpegCommand;
    on(event: 'progress', callback: (progress: { percent?: number }) => void): FfmpegCommand;
    on(event: 'stderr', callback: (stderrLine: string) => void): FfmpegCommand;
    on(event: 'error', callback: (err: Error, stdout: string, stderr: string) => void): FfmpegCommand;
    on(event: 'end', callback: () => void): FfmpegCommand;
  }
}

export class VideoProcessor {
  private static mainWindow: BrowserWindow;
  private static readonly maxThreads = Math.max(1, os.cpus().length);

  static initialize(window: BrowserWindow) {
    this.mainWindow = window;
    this.setupFFmpeg();
    this.setupHandlers();
  }

  private static setupFFmpeg() {
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

  private static setupHandlers() {
    ipcMain.handle('detect-silence', (_, { filePath, threshold, minDuration }) => 
      this.detectSilence(filePath, threshold, minDuration));

    ipcMain.handle('trim-silence', (_, { filePath, segments, padding, outputPath, threadCount }) => 
      this.trimSilence(filePath, segments, padding, outputPath, threadCount));

    ipcMain.handle('get-save-file-path', async (_, filePath) => {
      const { name } = parse(filePath);
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
    });

    ipcMain.handle('open-file', async (_, filePath: string) => {
      try {
        await shell.openPath(filePath);
        return true;
      } catch (error) {
        return false;
      }
    });

    ipcMain.handle('get-max-threads', () => this.maxThreads);
  }

  private static sendProgress(value: number) {
    if (this.mainWindow?.webContents) {
      const progress = Math.min(100, Math.max(0, value)).toFixed(2);
      this.mainWindow.webContents.send('progress', progress);
    }
  }

  private static async detectSilence(
    filePath: string,
    threshold: number = -45,
    minDuration: number = 0.6
  ): Promise<SilentSegment[]> {
    return new Promise((resolve, reject) => {
      const segments: SilentSegment[] = [];
      let currentSegment: Partial<SilentSegment> = {};
      let totalDuration = 0;
      let currentTime = 0;
      let lastProgressUpdate = Date.now();

      ffmpeg(filePath)
        .audioFilters(`silencedetect=n=${threshold}dB:d=${minDuration}`)
        .format('null')
        .on('start', () => {
          this.sendProgress(0);
        })
        .on('codecData', (data: FFmpegCodecData) => {
          try {
            if (data?.duration) {
              const durationParts = data.duration.split(':');
              if (durationParts.length === 3) {
                const hours = parseInt(durationParts[0]);
                const minutes = parseInt(durationParts[1]);
                const seconds = parseFloat(durationParts[2]);
                totalDuration = hours * 3600 + minutes * 60 + seconds;
              } else if (data?.format?.duration) {
                totalDuration = parseFloat(data.format.duration);
              }
            }
          } catch (error) {}
        })
        .on('stderr', (stderrLine: string) => {
          const startMatch = stderrLine.match(/silence_start: ([\d.]+)/);
          const endMatch = stderrLine.match(/silence_end: ([\d.]+)/);
          const timeMatch = stderrLine.match(/time=(\d+):(\d+):(\d+.\d+)/);

          if (startMatch) {
            currentSegment.start = parseFloat(startMatch[1]);
          }
          if (endMatch) {
            currentSegment.end = parseFloat(endMatch[1]);
            if (currentSegment.start !== undefined && currentSegment.end !== undefined) {
              segments.push(currentSegment as SilentSegment);
              currentSegment = {};
            }
          }

          if (timeMatch && totalDuration > 0) {
            const now = Date.now();
            if (now - lastProgressUpdate >= 100) {
              const [hours, minutes, seconds] = timeMatch.slice(1).map(parseFloat);
              currentTime = hours * 3600 + minutes * 60 + seconds;
              const progress = (currentTime / totalDuration) * 100;
              this.sendProgress(Math.min(progress, 99));
              lastProgressUpdate = now;
            }
          }
        })
        .on('end', () => {
          this.sendProgress(100);
          resolve(segments);
        })
        .on('error', (err) => {
          reject(err);
        })
        .output('/dev/null')
        .run();
    });
  }

  private static async trimSilence(
    filePath: string,
    silentSegments: SilentSegment[],
    padding: number = 0.05,
    outputPath: string,
    threadCount: number = this.maxThreads
  ): Promise<string> {
    if (!silentSegments?.length) {
      throw new Error('No segments provided');
    }

    const threads = Math.min(Math.max(1, threadCount), this.maxThreads);

    return new Promise((resolve, reject) => {
      try {
        let filter = silentSegments.reduce((acc, segment, index, array) => {
          const start = index === 0 ? 0 : array[index - 1].end;
          const end = segment.start;
          
          if (start < end) {
            if (acc.length > 0) acc += '+';
            acc += `between(t,${start},${end})`;
          }
          
          return acc;
        }, '');

        const lastSegment = silentSegments[silentSegments.length - 1];
        if (lastSegment) {
          if (filter.length > 0) filter += '+';
          filter += `gte(t,${lastSegment.end})`;
        }

        const command = ffmpeg(filePath)
          .videoFilters(`select='${filter}',setpts=N/FRAME_RATE/TB`)
          .audioFilters(`aselect='${filter}',asetpts=N/SR/TB`)
          .outputOptions([
            '-threads', threads.toString(),
            '-c:v', 'libx264',
            '-c:a', 'aac',
            '-movflags', '+faststart',
            '-preset', 'fast',
            '-crf', '23',
            '-maxrate', '5M',
            '-bufsize', '10M'
          ])
          .on('start', () => {
            this.sendProgress(0);
          })
          .on('progress', (progress) => {
            if (progress.percent) {
              this.sendProgress(progress.percent);
            }
          })
          .on('end', () => {
            this.sendProgress(100);
            resolve(outputPath);
          })
          .on('error', (err) => {
            reject(err);
          });

        command.save(outputPath);
      } catch (error) {
        reject(error);
      }
    });
  }
} 