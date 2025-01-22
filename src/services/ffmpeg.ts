import ffmpeg from 'fluent-ffmpeg';
import { promisify } from 'util';

export class FFmpegService {
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
} 