import { app, BrowserWindow, protocol, ipcMain, shell } from 'electron';
import { join } from 'path';
import isDev from 'electron-is-dev';
import { FFmpegService } from './ffmpeg';

let mainWindow: BrowserWindow | null = null;
let ffmpegService: FFmpegService | null = null;

// Register IPC handlers
ipcMain.handle('open-file', async (_, filePath: string) => {
  try {
    await shell.openPath(filePath.replace('file://', ''));
    return true;
  } catch (error) {
    console.error('Error opening file:', error);
    return false;
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, 'preload.js')
    },
  });

  const url = isDev
    ? 'http://localhost:3000'
    : `file://${join(__dirname, '../index.html')}`;

  mainWindow.loadURL(url);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // Initialize FFmpeg service after window creation
  if (mainWindow) {
    ffmpegService = FFmpegService.getInstance(mainWindow);

    // Handle IPC events
    ipcMain.handle('detect-silence', async (_, args) => {
      if (!ffmpegService) {
        throw new Error('FFmpeg service not initialized');
      }
      return await ffmpegService.detectSilence(args.filePath, args.threshold, args.minDuration);
    });

    ipcMain.handle('trim-silence', async (_, args) => {
      if (!ffmpegService) {
        throw new Error('FFmpeg service not initialized');
      }
      return await ffmpegService.trimSilence(args.filePath, args.segments, args.padding);
    });

    // Forward progress events from FFmpeg service to renderer
    ffmpegService.on('progress', (progress: number) => {
      if (mainWindow?.webContents) {
        mainWindow.webContents.send('progress', progress);
      }
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Register protocol and create window
app.whenReady().then(() => {
  // Register file protocol
  protocol.registerFileProtocol('local-file', (request, callback) => {
    const filePath = request.url.replace('local-file://', '');
    callback(decodeURI(filePath));
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
}); 