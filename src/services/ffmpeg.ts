declare global {
  interface Window {
    electron: {
      detectSilence: (args: { filePath: string; threshold: number; minDuration: number }) => Promise<SilentSegment[]>;
      trimSilence: (args: { filePath: string; segments: SilentSegment[]; padding: number }) => Promise<string>;
      openFile: (filePath: string) => Promise<boolean>;
      onProgress: (callback: (progress: number) => void) => void;
    };
  }
}

export interface SilentSegment {
  start: number;
  end: number;
}

export class FFmpegService {
  private static instance: FFmpegService;

  private constructor() {}

  public static getInstance(): FFmpegService {
    if (!FFmpegService.instance) {
      FFmpegService.instance = new FFmpegService();
    }
    return FFmpegService.instance;
  }

  static async getVideoInfo(filePath: string): Promise<any> {
    const ffprobePromise = promisify(ffmpeg.ffprobe);
    try {
      const info = await ffprobePromise(filePath);
      return info;
    } catch (error) {
      console.error('Error getting video info:', error);
      throw error;
    }
  }

  static async trimVideo(
    inputPath: string,
    outputPath: string,
    startTime: number,
    endTime: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .setStartTime(startTime)
        .setDuration(endTime - startTime)
        .output(outputPath)
        .on('end', () => {
          resolve();
        })
        .on('error', (err) => {
          console.error('Error trimming video:', err);
          reject(err);
        })
        .run();
    });
  }

  static async compressVideo(
    inputPath: string,
    outputPath: string,
    options: { videoBitrate?: string; audioBitrate?: string } = {}
  ): Promise<void> {
    const { videoBitrate = '1000k', audioBitrate = '128k' } = options;

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoBitrate(videoBitrate)
        .audioBitrate(audioBitrate)
        .output(outputPath)
        .on('end', () => {
          resolve();
        })
        .on('error', (err) => {
          console.error('Error compressing video:', err);
          reject(err);
        })
        .run();
    });
  }

  public async detectSilence(
    filePath: string,
    threshold: number = -45,
    minDuration: number = 0.6
  ): Promise<SilentSegment[]> {
    try {
      return await window.electron.detectSilence({
        filePath,
        threshold,
        minDuration
      });
    } catch (error) {
      console.error('Error detecting silence:', error);
      throw error;
    }
  }

  public async trimSilence(
    filePath: string,
    segments: SilentSegment[]
  ): Promise<string> {
    try {
      return await window.electron.trimSilence({
        filePath,
        segments,
        padding: 0
      });
    } catch (error) {
      console.error('Error trimming silence:', error);
      throw error;
    }
  }
} 