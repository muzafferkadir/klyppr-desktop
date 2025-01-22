import { contextBridge, ipcRenderer } from 'electron';
import { SilentSegment } from './ffmpeg';

type ElectronAPI = {
  detectSilence: (params: { filePath: string; threshold: number; minDuration: number }) => Promise<Array<{ start: number; end: number }>>;
  trimSilence: (params: { filePath: string; segments: Array<{ start: number; end: number }>; padding: number }) => Promise<string>;
  openFile: (filePath: string) => Promise<boolean>;
  onProgress: (callback: (progress: number) => void) => void;
};

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  detectSilence: (args: { filePath: string; threshold: number; minDuration: number }) => {
    return ipcRenderer.invoke('detect-silence', args);
  },
  trimSilence: (args: { filePath: string; segments: Array<{ start: number; end: number }>; padding: number }) => {
    return ipcRenderer.invoke('trim-silence', args);
  },
  openFile: (filePath: string) => {
    return ipcRenderer.invoke('open-file', filePath);
  },
  onProgress: (callback: (progress: number) => void) => {
    // Remove any existing listeners
    ipcRenderer.removeAllListeners('progress');
    // Add the new listener
    ipcRenderer.on('progress', (_, progress) => {
      console.log('Progress in preload:', progress);
      callback(progress);
    });
  }
}); 