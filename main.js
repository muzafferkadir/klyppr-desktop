const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');

// Use FFmpeg from node_modules in development mode
const isDev = process.env.NODE_ENV === 'development';

// Check FFmpeg binaries and set permissions
async function setupFFmpegBinaries() {
    const isDevelopment = process.env.NODE_ENV === 'development';
    const isWindows = process.platform === 'win32';
    
    let ffmpegPath, ffprobePath;
    
    if (isDevelopment) {
        // Development ortamında
        if (isWindows) {
            ffmpegPath = path.join(__dirname, 'bin', 'win', 'ffmpeg.exe');
            ffprobePath = path.join(__dirname, 'bin', 'win', 'ffprobe.exe');
        } else {
            ffmpegPath = path.join(__dirname, 'bin', 'mac', 'ffmpeg');
            ffprobePath = path.join(__dirname, 'bin', 'mac', 'ffprobe');
        }
    } else {
        // Production ortamında
        if (isWindows) {
            ffmpegPath = path.join(process.resourcesPath, 'bin', 'ffmpeg.exe');
            ffprobePath = path.join(process.resourcesPath, 'bin', 'ffprobe.exe');
        } else {
            ffmpegPath = path.join(process.resourcesPath, 'bin', 'ffmpeg');
            ffprobePath = path.join(process.resourcesPath, 'bin', 'ffprobe');
        }
    }

    console.log('FFmpeg Path:', ffmpegPath);
    console.log('FFprobe Path:', ffprobePath);

    if (!fs.existsSync(ffmpegPath) || !fs.existsSync(ffprobePath)) {
        throw new Error('FFmpeg or FFprobe binaries not found.');
    }

    return { ffmpegPath, ffprobePath };
}

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('index.html');
}

// When application starts
app.whenReady().then(async () => {
    try {
        await setupFFmpegBinaries();
        createWindow();
    } catch (error) {
        console.error('Application startup error:', error);
        app.quit();
    }
});

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

// Input file selection
ipcMain.on('select-input', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [
            { name: 'Video Files', extensions: ['mp4', 'avi', 'mov', 'mkv'] }
        ]
    });

    if (!result.canceled && result.filePaths.length > 0) {
        event.reply('input-selected', result.filePaths[0]);
    }
});

// Output folder selection
ipcMain.on('select-output', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });

    if (!result.canceled && result.filePaths.length > 0) {
        event.reply('output-selected', result.filePaths[0]);
    }
});

// Video processing
ipcMain.on('start-processing', async (event, params) => {
    try {
        const outputFile = path.join(
            params.outputPath,
            `processed_${path.basename(params.inputPath)}`
        );

        // Detect silences
        const silenceRanges = await detectSilence(params.inputPath, params, event);

        if (silenceRanges.length === 0) {
            event.reply('log', 'No silence found, copying file...');
            await fs.copyFile(params.inputPath, outputFile);
            event.reply('completed', true);
            return;
        }

        // Process video
        await processVideo(params.inputPath, outputFile, silenceRanges, event);
        event.reply('completed', true);
    } catch (error) {
        event.reply('log', `Error: ${error.message}`);
        event.reply('completed', false);
    }
});

async function detectSilence(inputFile, params, event) {
    return new Promise((resolve, reject) => {
        let silenceRanges = [];
        let startTime = null;

        event.reply('log', 'Starting silence analysis...');

        ffmpeg(inputFile)
            .outputOptions(['-f', 'null'])
            .audioFilters(`silencedetect=noise=${params.silenceDb}dB:d=${params.minSilenceDuration}`)
            .output('-')
            .on('start', command => {
                event.reply('log', `Running FFmpeg command: ${command}`);
            })
            .on('stderr', line => {
                const silenceStart = line.match(/silence_start: ([\d.]+)/);
                const silenceEnd = line.match(/silence_end: ([\d.]+)/);

                if (silenceStart) {
                    startTime = parseFloat(silenceStart[1]);
                    event.reply('log', `Silence start: ${startTime}s`);
                }
                if (silenceEnd && startTime !== null) {
                    const endTime = parseFloat(silenceEnd[1]);
                    event.reply('log', `Silence end: ${endTime}s`);
                    
                    silenceRanges.push({
                        start: startTime + parseFloat(params.paddingDuration),
                        end: endTime - parseFloat(params.paddingDuration)
                    });
                    startTime = null;
                }
            })
            .on('end', () => {
                event.reply('log', `Found ${silenceRanges.length} silence ranges`);
                resolve(silenceRanges);
            })
            .on('error', reject)
            .run();
    });
}

async function processVideo(inputFile, outputFile, silenceRanges, event) {
    return new Promise((resolve, reject) => {
        // Create a select filter that skips silent parts
        let selectParts = [];
        
        // First part
        if (silenceRanges[0].start > 0) {
            selectParts.push(`between(t,0,${silenceRanges[0].start})`);
        }

        // Parts between silences
        for (let i = 0; i < silenceRanges.length - 1; i++) {
            selectParts.push(
                `between(t,${silenceRanges[i].end},${silenceRanges[i + 1].start})`
            );
        }

        // Last part
        const lastSilence = silenceRanges[silenceRanges.length - 1];
        selectParts.push(`gte(t,${lastSilence.end})`);

        const selectFilter = selectParts.join('+');
        event.reply('log', 'Starting video processing...');

        const isWindows = process.platform === 'win32';
        
        const ffmpegCommand = ffmpeg(inputFile)
            .videoFilters([
                `select='${selectFilter}'`,
                'setpts=N/FRAME_RATE/TB'
            ])
            .audioFilters([
                `aselect='${selectFilter}'`,
                'asetpts=N/SR/TB'
            ]);

        // Platform specific encoding settings
        if (isWindows) {
            ffmpegCommand.outputOptions([
                '-c:v', 'mpeg4',
                '-q:v', '5',
                '-c:a', 'mp3',
                '-b:a', '128k'
            ]);
        } else {
            ffmpegCommand.outputOptions([
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '23',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-movflags', '+faststart'
            ]);
        }

        ffmpegCommand
            .on('start', command => {
                event.reply('log', `Running FFmpeg command: ${command}`);
            })
            .on('progress', progress => {
                const percent = progress.percent ? progress.percent.toFixed(1) : '0';
                event.reply('progress', {
                    status: `Processing: ${percent}%`,
                    percent: parseFloat(percent)
                });
            })
            .on('end', () => {
                event.reply('log', 'Video processing completed');
                resolve();
            })
            .on('error', (err) => {
                event.reply('log', `Error: ${err.message}`);
                reject(err);
            })
            .save(outputFile);
    });
} 