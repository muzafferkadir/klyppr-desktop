import { contextBridge, ipcRenderer } from 'electron';
import { SilentSegment } from './ffmpeg';

type ElectronAPI = {
  detectSilence: (params: { filePath: string; threshold: number; minDuration: number }) => Promise<Array<{ start: number; end: number }>>;
  trimSilence: (params: { filePath: string; segments: Array<{ start: number; end: number }>; padding: number }) => Promise<string>;
  openFile: (filePath: string) => Promise<boolean>;
  onProgress: (callback: (progress: number) => void) => void;
};

const api: ElectronAPI = {
  detectSilence: (params) => ipcRenderer.invoke('detect-silence', params),
  trimSilence: (params) => ipcRenderer.invoke('trim-silence', params),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  onProgress: (callback) => ipcRenderer.on('progress', (_, progress) => callback(progress))
};

contextBridge.exposeInMainWorld('electron', api); 