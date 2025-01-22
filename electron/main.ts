import { app, BrowserWindow, protocol, ipcMain, shell } from 'electron';
import { join } from 'path';
import isDev from 'electron-is-dev';
import { FFmpegService } from './ffmpeg';

let mainWindow: BrowserWindow | null = null;
let ffmpegService: FFmpegService | null = null;

// Clean up existing IPC handlers
function cleanupIpcHandlers() {
  ipcMain.removeHandler('detect-silence');
  ipcMain.removeHandler('trim-silence');
  ipcMain.removeHandler('open-file');
}

function createWindow() {
  // Cleanup existing handlers before creating new ones
  cleanupIpcHandlers();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, 'preload.js')
    },
  });

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

  const appPath = app.getAppPath();
  console.log('App Path:', appPath);
  console.log('__dirname:', __dirname);

  let url: string;
  if (isDev) {
    url = 'http://localhost:3000';
    // Only open DevTools in development
    mainWindow.webContents.openDevTools();
  } else {
    // In production, use the bundled renderer
    const rendererPath = join(process.resourcesPath, 'renderer/index.html');
    console.log('Renderer path:', rendererPath);
    url = `file://${rendererPath}`;
  }

  console.log('Loading URL:', url);

  mainWindow.loadURL(url).catch((err) => {
    console.error('Failed to load URL:', err);
  });

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
    // Cleanup handlers when window is closed
    cleanupIpcHandlers();
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