const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');

// Check FFmpeg binaries and set permissions
async function setupFFmpegBinaries() {
    const isDevelopment = process.env.NODE_ENV === 'development';
    const isWindows = process.platform === 'win32';
    
    let ffmpegPath, ffprobePath;
    
    if (isDevelopment) {
        // Development environment
        if (isWindows) {
            ffmpegPath = path.join(__dirname, 'bin', 'win', 'ffmpeg.exe');
            ffprobePath = path.join(__dirname, 'bin', 'win', 'ffprobe.exe');
        } else {
            ffmpegPath = path.join(__dirname, 'bin', 'mac', 'ffmpeg');
            ffprobePath = path.join(__dirname, 'bin', 'mac', 'ffprobe');
        }
    } else {
        // Production environment
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

    // Check if binaries exist
    if (!fs.existsSync(ffmpegPath) || !fs.existsSync(ffprobePath)) {
        console.error('FFmpeg binary not found at:', ffmpegPath);
        console.error('FFprobe binary not found at:', ffprobePath);
        throw new Error('FFmpeg or FFprobe binaries not found.');
    }

    // Set FFmpeg paths
    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);

    return { ffmpegPath, ffprobePath };
}

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 900,
        minWidth: 800,
        maxWidth: 800,
        minHeight: 600,
        show: false,
        titleBarStyle: 'default',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('index.html');
    
    // Show window when ready to prevent visual flash
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });
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

        // Phase 1: Detect silences with progress
        event.reply('progress', {
            status: 'Phase 1: Analyzing audio for silence...',
            percent: 0
        });

        const silenceRanges = await detectSilence(params.inputPath, params, event);

        if (silenceRanges.length === 0) {
            event.reply('log', 'No silence found, copying file...');
            event.reply('progress', {
                status: 'No silences detected - copying original file...',
                percent: 90
            });
            await fs.copyFile(params.inputPath, outputFile);
            event.reply('progress', {
                status: 'Complete! No processing needed.',
                percent: 100
            });
            event.reply('completed', true);
            return;
        }

        // Phase 2: Process video
        event.reply('progress', {
            status: 'Phase 2: Processing video (removing silences)...',
            percent: 0
        });
        
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
                    const paddingDur = parseFloat(params.paddingDuration);
                    const adjustedStart = startTime + paddingDur;
                    const adjustedEnd = endTime - paddingDur;
                    const duration = adjustedEnd - adjustedStart;
                    
                    event.reply('log', `Silence end: ${endTime}s`);
                    event.reply('log', `Padding: ${paddingDur}s, Duration after padding: ${duration.toFixed(3)}s`);
                    
                    // Only add if duration is positive and meaningful
                    if (duration > 0.05) {  // Minimum 50ms for audio frame safety
                        silenceRanges.push({
                            start: adjustedStart,
                            end: adjustedEnd
                        });
                        event.reply('log', `✓ Added silence range: ${adjustedStart.toFixed(3)}s - ${adjustedEnd.toFixed(3)}s`);
                    } else {
                        event.reply('log', `⚠️ Skipped too small silence: ${duration.toFixed(3)}s`);
                    }
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
        
        // Get input video duration for accurate progress calculation
        ffmpeg.ffprobe(inputFile, (err, metadata) => {
            let expectedOutputDuration = 0;
            
            if (!err && metadata && metadata.format && metadata.format.duration) {
                const inputDuration = metadata.format.duration;
                
                // Calculate total silence duration that will be removed
                let totalSilenceDuration = 0;
                silenceRanges.forEach(range => {
                    totalSilenceDuration += (range.end - range.start);
                });
                
                expectedOutputDuration = inputDuration - totalSilenceDuration;
                event.reply('log', `📊 Duration Analysis: Input=${inputDuration.toFixed(1)}s, Removing=${totalSilenceDuration.toFixed(1)}s, Expected Output=${expectedOutputDuration.toFixed(1)}s`);
            } else {
                event.reply('log', '⚠️ Could not determine video duration - using fallback progress');
            }

            event.reply('log', 'Starting video processing...');

            const isWindows = process.platform === 'win32';
            
            const ffmpegCommand = ffmpeg(inputFile)
                .videoFilters([
                    `select='${selectFilter}'`,
                    'setpts=N/FRAME_RATE/TB'
                ])
                .audioFilters([
                    `aselect='${selectFilter}'`,
                    'asetpts=N/SR/TB',
                    'aresample=async=1000'
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
                    let percent = 0;
                    let status = 'Processing...';
                    
                    if (expectedOutputDuration > 0 && progress.timemark) {
                        // Parse FFmpeg timemark (format: "00:01:23.45")
                        const timeMatch = progress.timemark.match(/(\d{2}):(\d{2}):(\d{2})\.?(\d{2})?/);
                        
                        if (timeMatch) {
                            const hours = parseInt(timeMatch[1]) || 0;
                            const minutes = parseInt(timeMatch[2]) || 0;
                            const seconds = parseInt(timeMatch[3]) || 0;
                            const centiseconds = parseInt(timeMatch[4]) || 0;
                            
                            const processedSeconds = hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
                            percent = Math.min(100, (processedSeconds / expectedOutputDuration) * 100);
                            
                            const expectedMin = Math.floor(expectedOutputDuration / 60);
                            const expectedSec = Math.floor(expectedOutputDuration % 60);
                            status = `Processing: ${percent.toFixed(1)}% (${progress.timemark}/${expectedMin}:${String(expectedSec).padStart(2, '0')})`;
                        }
                    } else if (progress.percent && progress.percent > 0) {
                        // Fallback to FFmpeg's built-in percent
                        percent = Math.min(100, progress.percent);
                        status = `Processing: ${percent.toFixed(1)}% (estimated)`;
                    } else {
                        // No reliable progress data
                        status = 'Processing... (progress unknown)';
                        percent = 0;
                    }
                    
                    event.reply('progress', {
                        status: status,
                        percent: Math.max(0, Math.min(100, percent))
                    });
                })
                .on('end', () => {
                    event.reply('log', '✅ Video processing completed successfully');
                    event.reply('progress', {
                        status: 'Processing: 100% - Complete!',
                        percent: 100
                    });
                    resolve();
                })
                .on('error', (err) => {
                    event.reply('log', `❌ Error: ${err.message}`);
                    reject(err);
                })
                .save(outputFile);
        });
    });
} 