const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');

// ============================================================================
// CONSTANTS
// ============================================================================

Menu.setApplicationMenu(null);

const configPath = path.join(app.getPath('userData'), 'config.json');

const MIN_SEGMENT_DURATION = 0.05; // Minimum 50ms for audio frame safety
const PROGRESS_EXTRACTION_MAX = 90; // Max progress during segment extraction
const PROGRESS_CONCAT_START = 90; // Progress when starting concat
const TEMP_DIR_NAME = '.klyppr_temp';

const PLATFORM = {
    isWindows: process.platform === 'win32',
    isDevelopment: process.env.NODE_ENV === 'development'
};

const QUALITY_SETTINGS = {
    fast: {
        preset: 'ultrafast',
        crf: 28,        // Lower quality, smaller file
        qv: 6           // Windows mpeg4 quality (higher = lower quality)
    },
    medium: {
        preset: 'veryfast',
        crf: 23,        // Balanced quality
        qv: 5           // Windows mpeg4 quality
    },
    high: {
        preset: 'medium',
        crf: 18,        // Higher quality, larger file
        qv: 3           // Windows mpeg4 quality (lower = higher quality)
    }
};

// ============================================================================
// CONFIG FUNCTIONS
// ============================================================================

function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (error) {
        console.error('Error reading config:', error);
    }
    return {};
}

function saveConfig(config) {
    try {
        fs.ensureDirSync(path.dirname(configPath));
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch (error) {
        console.error('Error saving config:', error);
    }
}

// ============================================================================
// FFMPEG SETUP
// ============================================================================

function getFFmpegPaths() {
    const { isDevelopment, isWindows } = PLATFORM;
    const baseDir = isDevelopment ? __dirname : process.resourcesPath;
    const platformDir = isWindows ? 'win' : 'mac';
    const extension = isWindows ? '.exe' : '';
    
    return {
        ffmpeg: path.join(baseDir, 'bin', platformDir, `ffmpeg${extension}`),
        ffprobe: path.join(baseDir, 'bin', platformDir, `ffprobe${extension}`)
    };
}

async function setupFFmpegBinaries() {
    const { ffmpeg: ffmpegPath, ffprobe: ffprobePath } = getFFmpegPaths();
    
    if (!fs.existsSync(ffmpegPath) || !fs.existsSync(ffprobePath)) {
        throw new Error('FFmpeg or FFprobe binaries not found.');
    }
    
    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);
    
    return { ffmpegPath, ffprobePath };
}

// ============================================================================
// WINDOW MANAGEMENT
// ============================================================================

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 800,
        minWidth: 1200,
        minHeight: 700,
        show: false,
        titleBarStyle: 'default',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    
    mainWindow.loadFile('index.html');
    mainWindow.once('ready-to-show', () => mainWindow.show());
}

// ============================================================================
// VIDEO METADATA HELPERS
// ============================================================================

function getVideoMetadata(inputFile) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputFile, (err, metadata) => {
            if (err) reject(err);
            else resolve(metadata);
        });
    });
}

function calculateDurationStats(silenceRanges, inputDuration) {
    const totalSilenceDuration = silenceRanges.reduce(
        (sum, range) => sum + (range.end - range.start),
        0
    );
    const expectedOutputDuration = inputDuration - totalSilenceDuration;
    
    return {
        inputDuration,
        totalSilenceDuration,
        expectedOutputDuration
    };
}

// ============================================================================
// SEGMENT CALCULATION
// ============================================================================

function calculateTalkingRanges(silenceRanges, videoDuration) {
    const talkingRanges = [];
    let prevEnd = 0;
    
    for (const range of silenceRanges) {
        if (prevEnd < range.start) {
            const duration = range.start - prevEnd;
            if (duration > MIN_SEGMENT_DURATION) {
                talkingRanges.push({ start: prevEnd, end: range.start });
            }
        }
        prevEnd = range.end;
    }
    
    if (prevEnd < videoDuration) {
        const duration = videoDuration - prevEnd;
        if (duration > MIN_SEGMENT_DURATION) {
            talkingRanges.push({ start: prevEnd, end: videoDuration });
        }
    }
    
    return talkingRanges;
}

// ============================================================================
// ENCODING SETTINGS
// ============================================================================

function getEncodingOptions(qualityPreset = 'medium') {
    const { isWindows } = PLATFORM;
    
    const quality = QUALITY_SETTINGS[qualityPreset] || QUALITY_SETTINGS.medium;
    
    if (isWindows) {
        return {
            videoCodec: 'mpeg4',
            videoQuality: ['-q:v', quality.qv.toString()],
            audioCodec: 'mp3',
            audioBitrate: '128k'
        };
    }
    
    return {
        videoCodec: 'libx264',
        videoQuality: ['-preset', quality.preset, '-crf', quality.crf.toString()],
        audioCodec: 'aac',
        audioBitrate: '128k',
        extraOptions: ['-movflags', '+faststart']
    };
}

function buildSegmentOutputOptions(qualityPreset = 'medium') {
    const encoding = getEncodingOptions(qualityPreset);
    const options = [
        '-c:v', encoding.videoCodec,
        ...encoding.videoQuality,
        '-c:a', encoding.audioCodec,
        '-b:a', encoding.audioBitrate,
        '-avoid_negative_ts', 'make_zero'
    ];
    
    if (encoding.extraOptions) {
        options.push(...encoding.extraOptions);
    }
    
    return options;
}

// ============================================================================
// SEGMENT EXTRACTION
// ============================================================================

function extractSegment(inputFile, segmentOutput, start, end, segmentIndex, totalSegments, qualityPreset, event) {
    return new Promise((resolve, reject) => {
        const duration = end - start;
        const outputOptions = buildSegmentOutputOptions(qualityPreset);
        
        ffmpeg(inputFile)
            .seekInput(start)
            .duration(duration)
            .outputOptions(outputOptions)
            .on('end', () => {
                event.reply('log', `✓ Segment ${segmentIndex + 1}/${totalSegments}: ${start.toFixed(2)}s - ${end.toFixed(2)}s`);
                resolve();
            })
            .on('error', (err) => {
                event.reply('log', `❌ Segment ${segmentIndex + 1} error: ${err.message}`);
                reject(err);
            })
            .save(segmentOutput);
    });
}

async function extractAllSegments(inputFile, talkingRanges, tempDir, qualityPreset, event) {
    const tempFiles = [];
    
    for (let i = 0; i < talkingRanges.length; i++) {
        const { start, end } = talkingRanges[i];
        const segmentOutput = path.join(tempDir, `segment_${i.toString().padStart(4, '0')}.mp4`);
        tempFiles.push(segmentOutput);
        
        await extractSegment(inputFile, segmentOutput, start, end, i, talkingRanges.length, qualityPreset, event);
        
        // Calculate progress: (current segment / total segments) * max progress
        const segmentProgress = ((i + 1) / talkingRanges.length) * 100;
        const progress = Math.round((segmentProgress / 100) * PROGRESS_EXTRACTION_MAX);
        
        event.reply('progress', {
            status: `Extracting segment ${i + 1}/${talkingRanges.length} (${Math.round(segmentProgress)}%)...`,
            percent: progress
        });
    }
    
    return tempFiles;
}

// ============================================================================
// CONCATENATION
// ============================================================================

function createConcatFile(tempFiles, tempDir) {
    const concatFile = path.join(tempDir, 'concat_list.txt');
    const concatContent = tempFiles.map(file => {
        const normalizedPath = path.resolve(file).replace(/\\/g, '/').replace(/'/g, "\\'");
        return `file '${normalizedPath}'`;
    }).join('\n');
    
    return { concatFile, concatContent };
}

function concatSegments(concatFile, outputFile, totalSegments, normalizeAudio, qualityPreset, event) {
    return new Promise((resolve, reject) => {
        const encoding = getEncodingOptions(qualityPreset);
        
        const ffmpegCmd = ffmpeg()
            .input(concatFile)
            .inputOptions(['-f', 'concat', '-safe', '0']);
        
        if (normalizeAudio) {
            // Re-encode with audio normalization
            event.reply('log', `🔊 Normalizing audio to -16 LUFS (YouTube standard)...`);
            ffmpegCmd
                .outputOptions([
                    '-c:v', encoding.videoCodec,
                    ...encoding.videoQuality,
                    '-c:a', encoding.audioCodec,
                    '-b:a', encoding.audioBitrate,
                    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
                    '-avoid_negative_ts', 'make_zero',
                    '-fflags', '+genpts'
                ]);
            
            if (encoding.extraOptions) {
                ffmpegCmd.outputOptions(encoding.extraOptions);
            }
        } else {
            // Fast copy (no re-encoding)
            ffmpegCmd.outputOptions([
                '-c', 'copy',
                '-avoid_negative_ts', 'make_zero',
                '-fflags', '+genpts'
            ]);
        }
        
        ffmpegCmd
            .on('start', () => {
                event.reply('log', `⚙️ Merging ${totalSegments} segments...`);
                // Set initial progress
                event.reply('progress', {
                    status: normalizeAudio ? 'Merging & normalizing...' : 'Merging segments...',
                    percent: PROGRESS_CONCAT_START
                });
            })
            .on('progress', (progress) => {
                // FFmpeg progress.percent might be undefined for concat operations
                // Only update if we have valid, reasonable progress data
                if (progress && typeof progress.percent === 'number' && !isNaN(progress.percent)) {
                    const percentValue = parseFloat(progress.percent);
                    if (percentValue >= 0 && percentValue <= 100) {
                        const concatProgress = PROGRESS_CONCAT_START + (percentValue / 10);
                        const finalPercent = Math.min(100, Math.max(PROGRESS_CONCAT_START, concatProgress));
                        
                        event.reply('progress', {
                            status: normalizeAudio ? `Merging & normalizing: ${percentValue.toFixed(1)}%` : `Merging: ${percentValue.toFixed(1)}%`,
                            percent: finalPercent
                        });
                    }
                }
            })
            .on('end', () => {
                event.reply('log', normalizeAudio ? `✅ Segments merged and audio normalized` : `✅ Segments merged successfully`);
                resolve();
            })
            .on('error', (err) => {
                event.reply('log', `❌ Concat error: ${err.message}`);
                reject(err);
            })
            .save(outputFile);
    });
}

// ============================================================================
// AUDIO NORMALIZATION
// ============================================================================

function normalizeAudioOnly(inputFile, outputFile, qualityPreset, event) {
    return new Promise((resolve, reject) => {
        const encoding = getEncodingOptions(qualityPreset);
        
        ffmpeg(inputFile)
            .outputOptions([
                '-c:v', 'copy',
                '-c:a', encoding.audioCodec,
                '-b:a', encoding.audioBitrate,
                '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'
            ])
            .on('start', () => {
                event.reply('log', `⚙️ Normalizing audio...`);
                // Set initial progress
                event.reply('progress', {
                    status: 'Normalizing audio...',
                    percent: 50
                });
            })
            .on('progress', (progress) => {
                // FFmpeg progress.percent might be undefined or invalid
                // Only update if we have valid, reasonable progress data
                if (progress && typeof progress.percent === 'number' && !isNaN(progress.percent)) {
                    const percentValue = parseFloat(progress.percent);
                    if (percentValue >= 0 && percentValue <= 100) {
                        const normalizeProgress = 50 + (percentValue / 2);
                        const finalPercent = Math.min(100, Math.max(50, normalizeProgress));
                        
                        event.reply('progress', {
                            status: `Normalizing: ${percentValue.toFixed(1)}%`,
                            percent: finalPercent
                        });
                    }
                }
            })
            .on('end', () => {
                event.reply('log', `✅ Audio normalized successfully`);
                resolve();
            })
            .on('error', (err) => {
                event.reply('log', `❌ Normalization error: ${err.message}`);
                reject(err);
            })
            .save(outputFile);
    });
}

// ============================================================================
// SILENCE DETECTION
// ============================================================================

function parseSilenceLine(line) {
    const silenceStart = line.match(/silence_start: ([\d.]+)/);
    const silenceEnd = line.match(/silence_end: ([\d.]+)/);
    return {
        start: silenceStart ? parseFloat(silenceStart[1]) : null,
        end: silenceEnd ? parseFloat(silenceEnd[1]) : null
    };
}

function processSilenceRange(startTime, endTime, paddingDuration) {
    const adjustedStart = startTime + paddingDuration;
    const adjustedEnd = endTime - paddingDuration;
    const duration = adjustedEnd - adjustedStart;
    
    return {
        adjustedStart,
        adjustedEnd,
        duration
    };
}

async function detectSilence(inputFile, params, event) {
    return new Promise((resolve, reject) => {
        const silenceRanges = [];
        let startTime = null;
        
        event.reply('log', `🔍 Starting silence analysis...`);
        
        ffmpeg(inputFile)
            .outputOptions(['-f', 'null'])
            .audioFilters(`silencedetect=noise=${params.silenceDb}dB:d=${params.minSilenceDuration}`)
            .output('-')
            .on('start', command => {
                event.reply('log', `⚙️ FFmpeg: ${command}`);
            })
            .on('stderr', line => {
                const { start, end } = parseSilenceLine(line);
                
                if (start !== null) {
                    startTime = start;
                    event.reply('log', `🔇 Start: ${startTime}s`);
                }
                
                if (end !== null && startTime !== null) {
                    const paddingDur = parseFloat(params.paddingDuration);
                    const { adjustedStart, adjustedEnd, duration } = processSilenceRange(startTime, end, paddingDur);
                    
                    event.reply('log', `🔊 End: ${end}s | Padding: ${paddingDur}s | Duration: ${duration.toFixed(3)}s`);
                    
                    if (duration > MIN_SEGMENT_DURATION) {
                        silenceRanges.push({ start: adjustedStart, end: adjustedEnd });
                        event.reply('log', `✓ Range: ${adjustedStart.toFixed(3)}s - ${adjustedEnd.toFixed(3)}s`);
                    } else {
                        event.reply('log', `⚠️ Skipped: ${duration.toFixed(3)}s`);
                    }
                    startTime = null;
                }
            })
            .on('end', () => {
                event.reply('log', `✅ Found ${silenceRanges.length} silence ranges`);
                resolve(silenceRanges);
            })
            .on('error', reject)
            .run();
    });
}

// ============================================================================
// VIDEO PROCESSING
// ============================================================================

async function processVideo(inputFile, outputFile, silenceRanges, normalizeAudio, qualityPreset, event) {
    try {
        const metadata = await getVideoMetadata(inputFile);
        const inputDuration = metadata.format.duration;
        
        const talkingRanges = calculateTalkingRanges(silenceRanges, inputDuration);
        const stats = calculateDurationStats(silenceRanges, inputDuration);
        
        event.reply('log', `📊 Input: ${stats.inputDuration.toFixed(1)}s | Removing: ${stats.totalSilenceDuration.toFixed(1)}s | Expected: ${stats.expectedOutputDuration.toFixed(1)}s`);
        event.reply('log', `📦 Found ${talkingRanges.length} talking ranges - processing segments...`);
        event.reply('log', `🎨 Quality: ${qualityPreset} (${qualityPreset === 'fast' ? 'Faster, Lower Quality' : qualityPreset === 'high' ? 'Slower, Best Quality' : 'Balanced'})`);
        
        const tempDir = path.join(path.dirname(outputFile), TEMP_DIR_NAME);
        await fs.ensureDir(tempDir);
        
        const tempFiles = await extractAllSegments(inputFile, talkingRanges, tempDir, qualityPreset, event);
        
        event.reply('log', `🔗 Concatenating ${talkingRanges.length} segments...`);
        const { concatFile, concatContent } = createConcatFile(tempFiles, tempDir);
        await fs.writeFile(concatFile, concatContent, 'utf8');
        
        await concatSegments(concatFile, outputFile, talkingRanges.length, normalizeAudio, qualityPreset, event);
        
        event.reply('log', `🧹 Cleaning up temporary files...`);
        await fs.remove(tempDir);
        
        event.reply('log', `✅ Video processing completed successfully`);
        event.reply('progress', {
            status: 'Processing: 100% - Complete!',
            percent: 100
        });
    } catch (error) {
        event.reply('log', `❌ Error: ${error.message || error?.toString() || 'Unknown error'}`);
        throw error;
    }
}

// ============================================================================
// IPC HANDLERS
// ============================================================================

ipcMain.on('select-input', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Video Files', extensions: ['mp4', 'avi', 'mov', 'mkv'] }]
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
        event.reply('input-selected', result.filePaths[0]);
    }
});

ipcMain.on('select-output', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
        const outputPath = result.filePaths[0];
        event.reply('output-selected', outputPath);
        
        const config = loadConfig();
        config.lastOutputPath = outputPath;
        saveConfig(config);
    }
});

ipcMain.on('load-last-output', (event) => {
    const config = loadConfig();
    if (config.lastOutputPath && fs.existsSync(config.lastOutputPath)) {
        event.reply('output-selected', config.lastOutputPath);
    }
});

ipcMain.on('start-processing', async (event, params) => {
    try {
        const outputFile = path.join(
            params.outputPath,
            `processed_${path.basename(params.inputPath)}`
        );
        
        event.reply('progress', {
            status: 'Phase 1: Analyzing audio for silence...',
            percent: 0
        });
        
        const silenceRanges = await detectSilence(params.inputPath, params, event);
        
        if (silenceRanges.length === 0) {
            event.reply('log', `ℹ️ No silence found, processing file...`);
            event.reply('progress', {
                status: 'No silences detected - processing file...',
                percent: 50
            });
            
            if (params.normalizeAudio) {
                event.reply('log', `🔊 Normalizing audio to -16 LUFS (YouTube standard)...`);
                await normalizeAudioOnly(params.inputPath, outputFile, params.qualityPreset || 'medium', event);
            } else {
                await fs.copyFile(params.inputPath, outputFile);
            }
            
            event.reply('progress', {
                status: 'Complete! No processing needed.',
                percent: 100
            });
            event.reply('completed', { success: true, outputFile: outputFile });
            return;
        }
        
        event.reply('progress', {
            status: 'Phase 2: Processing video (removing silences)...',
            percent: 0
        });
        
        await processVideo(params.inputPath, outputFile, silenceRanges, params.normalizeAudio, params.qualityPreset || 'medium', event);
        event.reply('completed', { success: true, outputFile: outputFile });
    } catch (error) {
        event.reply('log', `❌ Error: ${error.message}`);
        event.reply('completed', { success: false, outputFile: null });
    }
});

ipcMain.on('show-in-folder', (event, filePath) => {
    shell.showItemInFolder(filePath);
});

// ============================================================================
// APP INITIALIZATION
// ============================================================================

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
