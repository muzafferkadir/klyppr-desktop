import { SilentSegment } from '@/services/ffmpeg';

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