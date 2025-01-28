import { contextBridge, ipcRenderer } from 'electron';

interface SilentSegment {
  start: number;
  end: number;
}

type Cleanup = () => void;

// Define IPC channel types
interface IpcChannels {
  'progress': string;
  'detect-silence': any;
  'trim-silence': any;
  'open-file': any;
  'get-save-file-path': any;
  'get-max-threads': string;
}

type ElectronAPI = {
  detectSilence: (args: { filePath: string; threshold: number; minDuration: number }) => Promise<SilentSegment[]>;
  trimSilence: (args: { filePath: string; segments: SilentSegment[]; padding: number; threadCount: number; outputPath: string }) => Promise<string>;
  openFile: (filePath: string) => Promise<boolean>;
  getSaveFilePath: (filePath: string) => Promise<string | null>;
  getMaxThreads: () => Promise<number>;
  onProgress: (callback: (progress: number) => void) => Cleanup;
};

// Type-safe IPC communication
const api: ElectronAPI = {
  detectSilence: (args) => ipcRenderer.invoke('detect-silence', args),
  trimSilence: (args) => ipcRenderer.invoke('trim-silence', args),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  getSaveFilePath: (filePath) => ipcRenderer.invoke('get-save-file-path', filePath),
  getMaxThreads: () => ipcRenderer.invoke('get-max-threads'),
  onProgress: (callback) => {
    const listener = (_: any, value: number) => callback(value);
    ipcRenderer.on('progress', listener);
    return () => ipcRenderer.removeListener('progress', listener);
  }
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electron', api); 