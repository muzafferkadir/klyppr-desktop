// Client-side FFmpeg service that communicates with Electron main process
export interface SilentSegment {
  start: number;
  end: number;
}

type Cleanup = () => void;

declare global {
  interface Window {
    electron: {
      detectSilence: (args: { filePath: string; threshold: number; minDuration: number }) => Promise<SilentSegment[]>;
      trimSilence: (args: { filePath: string; segments: SilentSegment[]; padding: number; threadCount: number; outputPath: string }) => Promise<string>;
      openFile: (filePath: string) => Promise<boolean>;
      onProgress: (callback: (progress: number) => void) => Cleanup;
      getSaveFilePath: (filePath: string) => Promise<string | null>;
    };
  }
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
    segments: SilentSegment[],
    options: { padding?: number; threadCount?: number; outputPath: string }
  ): Promise<string> {
    try {
      const result = await window.electron.trimSilence({
        filePath,
        segments,
        padding: options.padding ?? 0.05,
        threadCount: options.threadCount ?? 4,
        outputPath: options.outputPath
      });

      return result;
    } catch (error) {
      console.error('Error trimming silence:', error);
      throw error;
    }
  }

  public onProgress(callback: (progress: number) => void): Cleanup {
    return window.electron.onProgress(callback);
  }
} 