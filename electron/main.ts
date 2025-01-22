import { app, BrowserWindow, protocol, ipcMain, shell } from 'electron';
import { join } from 'path';
import isDev from 'electron-is-dev';
import './ffmpeg'; // Initialize FFmpeg service

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

  const url = isDev
    ? 'http://localhost:3000'
    : `file://${join(__dirname, '../index.html')}`;

  mainWindow.loadURL(url);

  if (isDev) {
    mainWindow.webContents.openDevTools();
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

// Handle file opening
ipcMain.handle('open-file', async (_, filePath) => {
  await shell.openPath(filePath);
  return true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
}); 