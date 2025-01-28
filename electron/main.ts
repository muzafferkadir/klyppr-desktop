import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import isDev from 'electron-is-dev';
import { VideoProcessor } from './video-processor';

let mainWindow: BrowserWindow | null = null;

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

  const url = isDev ? 'http://localhost:3000' : `file://${join(process.resourcesPath, 'renderer/index.html')}`;
  mainWindow.loadURL(url);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  if (mainWindow) {
    VideoProcessor.initialize(mainWindow);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
}); 