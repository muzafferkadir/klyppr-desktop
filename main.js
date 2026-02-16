const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');
const { execSync } = require('child_process');

// ============================================================================
// CONSTANTS
// ============================================================================

Menu.setApplicationMenu(null);

const configPath = path.join(app.getPath('userData'), 'config.json');
const MIN_SEGMENT_DURATION = 0.05;
const TEMP_DIR_NAME = '.klyppr_temp';

const PLATFORM = {
    isWindows: process.platform === 'win32',
    isDevelopment: process.env.NODE_ENV === 'development'
};

const QUALITY_SETTINGS = {
    fast: { preset: 'ultrafast', crf: 28, qv: 6 },
    medium: { preset: 'veryfast', crf: 23, qv: 5 },
    high: { preset: 'medium', crf: 18, qv: 3 }
};

// GPU encoder quality settings (higher = better quality)
const HW_QUALITY_SETTINGS = {
    // VideoToolbox (macOS) — uses quality percentage (1-100)
    videotoolbox: { fast: 35, medium: 55, high: 75 },
    // NVENC (NVIDIA) — uses CQ value (lower = better, like CRF)
    nvenc: { fast: 32, medium: 24, high: 18 },
    // QSV (Intel) — uses global_quality
    qsv: { fast: 32, medium: 24, high: 18 },
    // AMF (AMD) — uses quality level
    amf: { fast: 32, medium: 24, high: 18 }
};

// Detected at startup — null means software encoding
let detectedHWEncoder = null;

// ============================================================================
// ACTIVE PROCESS TRACKING (for cancel support)
// ============================================================================

let currentFFmpegProcess = null;
let isCancelled = false;

function setActiveProcess(proc) {
    currentFFmpegProcess = proc;
}

function clearActiveProcess() {
    currentFFmpegProcess = null;
}

function cancelActiveProcess() {
    isCancelled = true;
    if (currentFFmpegProcess) {
        try {
            currentFFmpegProcess.kill('SIGTERM');
        } catch (e) { /* Process may have already exited */ }
        clearActiveProcess();
    }
}

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
    const extension = isWindows ? '.exe' : '';

    if (isDevelopment) {
        const platformDir = isWindows ? 'win' : 'mac';
        return {
            ffmpeg: path.join(baseDir, 'bin', platformDir, `ffmpeg${extension}`),
            ffprobe: path.join(baseDir, 'bin', platformDir, `ffprobe${extension}`)
        };
    } else {
        return {
            ffmpeg: path.join(baseDir, 'bin', `ffmpeg${extension}`),
            ffprobe: path.join(baseDir, 'bin', `ffprobe${extension}`)
        };
    }
}

async function setupFFmpegBinaries() {
    const { ffmpeg: ffmpegPath, ffprobe: ffprobePath } = getFFmpegPaths();

    if (!fs.existsSync(ffmpegPath) || !fs.existsSync(ffprobePath)) {
        throw new Error('FFmpeg or FFprobe binaries not found.');
    }

    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);

    // Detect GPU hardware encoder
    detectedHWEncoder = detectHardwareEncoder(ffmpegPath);

    return { ffmpegPath, ffprobePath };
}

/**
 * Detect available hardware video encoders at startup.
 * Runs `ffmpeg -encoders` and checks for GPU-accelerated H.264 encoders.
 * Returns encoder info object or null if no hardware encoder is available.
 */
function detectHardwareEncoder(ffmpegPath) {
    try {
        const output = execSync(`"${ffmpegPath}" -encoders -hide_banner 2>/dev/null`, {
            encoding: 'utf8',
            timeout: 5000
        });

        const { isWindows } = PLATFORM;

        if (!isWindows) {
            // macOS: try VideoToolbox
            if (output.includes('h264_videotoolbox')) {
                console.log('🎮 Hardware encoder detected: h264_videotoolbox (Apple GPU)');
                return { codec: 'h264_videotoolbox', type: 'videotoolbox' };
            }
        } else {
            // Windows: try NVENC → QSV → AMF (in order of preference)
            if (output.includes('h264_nvenc')) {
                console.log('🎮 Hardware encoder detected: h264_nvenc (NVIDIA GPU)');
                return { codec: 'h264_nvenc', type: 'nvenc' };
            }
            if (output.includes('h264_qsv')) {
                console.log('🎮 Hardware encoder detected: h264_qsv (Intel GPU)');
                return { codec: 'h264_qsv', type: 'qsv' };
            }
            if (output.includes('h264_amf')) {
                console.log('🎮 Hardware encoder detected: h264_amf (AMD GPU)');
                return { codec: 'h264_amf', type: 'amf' };
            }
        }

        console.log('💻 No hardware encoder found — using software encoding');
        return null;
    } catch (e) {
        console.log('💻 Hardware detection failed — using software encoding');
        return null;
    }
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
        (sum, range) => sum + (range.end - range.start), 0
    );
    return {
        inputDuration,
        totalSilenceDuration,
        expectedOutputDuration: inputDuration - totalSilenceDuration
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

function getEncodingOptions(qualityPreset = 'medium', useHardwareEncoder = true) {
    const { isWindows } = PLATFORM;
    const quality = QUALITY_SETTINGS[qualityPreset] || QUALITY_SETTINGS.medium;
    const preset = qualityPreset || 'medium';

    // GPU hardware encoding (if detected AND user opted in)
    if (detectedHWEncoder && useHardwareEncoder) {
        const hwQuality = HW_QUALITY_SETTINGS[detectedHWEncoder.type] || {};
        const qVal = hwQuality[preset] || hwQuality.medium;

        let videoQuality;
        switch (detectedHWEncoder.type) {
            case 'videotoolbox':
                // -q:v is quality percentage for VideoToolbox (higher = better)
                videoQuality = ['-q:v', qVal.toString()];
                break;
            case 'nvenc':
                // NVENC: preset + constant quality
                videoQuality = ['-preset', preset === 'fast' ? 'p1' : preset === 'high' ? 'p7' : 'p4',
                    '-cq', qVal.toString(), '-rc', 'vbr'];
                break;
            case 'qsv':
                // QSV: global_quality
                videoQuality = ['-global_quality', qVal.toString(), '-look_ahead', '1'];
                break;
            case 'amf':
                // AMF: quality preset + qp
                videoQuality = ['-quality', preset === 'fast' ? 'speed' : preset === 'high' ? 'quality' : 'balanced',
                    '-qp_i', qVal.toString(), '-qp_p', qVal.toString()];
                break;
            default:
                videoQuality = ['-q:v', qVal.toString()];
        }

        return {
            videoCodec: detectedHWEncoder.codec,
            videoQuality,
            audioCodec: isWindows ? 'mp3' : 'aac',
            audioBitrate: '128k',
            extraOptions: ['-threads', '0', '-movflags', '+faststart'],
            isHardware: true
        };
    }

    // Software encoding fallback
    return {
        videoCodec: 'libx264',
        videoQuality: qualityPreset === 'fast' ? ['-preset', 'ultrafast', '-crf', '28'] :
            qualityPreset === 'high' ? ['-preset', 'medium', '-crf', '18'] :
                ['-preset', 'veryfast', '-crf', '23'],
        audioCodec: isWindows ? 'mp3' : 'aac',
        audioBitrate: '128k',
        extraOptions: ['-threads', '0', '-movflags', '+faststart']
    };
}

// ============================================================================
// FILTER SCRIPT GENERATION (trim/atrim + concat)
// ============================================================================

function buildFilterScript(talkingRanges, normalizeAudio) {
    const filterParts = talkingRanges.map((r, i) =>
        `[0:v]trim=start=${r.start.toFixed(4)}:end=${r.end.toFixed(4)},setpts=PTS-STARTPTS[v${i}];` +
        `[0:a]atrim=start=${r.start.toFixed(4)}:end=${r.end.toFixed(4)},asetpts=PTS-STARTPTS[a${i}]`
    );

    const concatInputs = talkingRanges.map((_, i) => `[v${i}][a${i}]`).join('');

    let filterGraph = filterParts.join(';') + ';' + concatInputs +
        `concat=n=${talkingRanges.length}:v=1:a=1`;

    if (normalizeAudio) {
        filterGraph += `[tmpv][tmpa];[tmpv]copy[outv];[tmpa]loudnorm=I=-16:TP=-1.5:LRA=11[outa]`;
    } else {
        filterGraph += `[outv][outa]`;
    }

    return filterGraph;
}

async function writeFilterScript(filterGraph, tempDir) {
    await fs.ensureDir(tempDir);
    const scriptPath = path.join(tempDir, 'filter_script.txt');
    await fs.writeFile(scriptPath, filterGraph, 'utf8');
    return scriptPath;
}

// ============================================================================
// VIDEO PROCESSING (trim+atrim+concat via filter_complex_script)
// ============================================================================

function processVideoWithFilter(inputFile, outputFile, filterScriptPath, qualityPreset, expectedDuration, event, useHardwareEncoder = true) {
    return new Promise((resolve, reject) => {
        if (isCancelled) return reject(new Error('Processing cancelled'));

        const encoding = getEncodingOptions(qualityPreset, useHardwareEncoder);
        const outputOptions = [
            '-filter_complex_script', filterScriptPath,
            '-map', '[outv]',
            '-map', '[outa]',
            '-c:v', encoding.videoCodec,
            ...encoding.videoQuality,
            '-c:a', encoding.audioCodec,
            '-b:a', encoding.audioBitrate,
            '-avoid_negative_ts', 'make_zero',
            '-threads', '0'
        ];
        if (encoding.extraOptions) outputOptions.push(...encoding.extraOptions);

        if (encoding.isHardware) {
            event.reply('log', `🎮 Using hardware encoder: ${encoding.videoCodec}`);
        } else {
            event.reply('log', `💻 Using software encoder: ${encoding.videoCodec}`);
        }

        const startTime = Date.now();

        const cmd = ffmpeg(inputFile)
            .outputOptions(outputOptions)
            .on('start', (command) => {
                event.reply('log', `⚙️ FFmpeg: ${command}`);
            })
            .on('progress', (progress) => {
                if (isCancelled) return;

                let percent = 0;
                if (progress && progress.timemark) {
                    const parts = progress.timemark.split(':');
                    if (parts.length === 3) {
                        const currentTime = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
                        percent = Math.min(99, Math.round((currentTime / expectedDuration) * 100));
                    }
                }

                const elapsed = (Date.now() - startTime) / 1000;
                let eta = '';
                if (percent > 5 && elapsed > 2) {
                    const remaining = Math.max(0, (elapsed / (percent / 100)) - elapsed);
                    eta = remaining < 60
                        ? ` — ~${Math.round(remaining)}s remaining`
                        : ` — ~${Math.round(remaining / 60)}m ${Math.round(remaining % 60)}s remaining`;
                }

                event.reply('progress', { status: `Processing: ${percent}%${eta}`, percent });
            })
            .on('end', () => {
                if (isCancelled) return reject(new Error('Processing cancelled'));
                clearActiveProcess();
                event.reply('progress', { status: 'Processing: 100% — Complete!', percent: 100 });
                resolve();
            })
            .on('error', (err) => {
                clearActiveProcess();
                if (isCancelled) reject(new Error('Processing cancelled'));
                else reject(err);
            })
            .save(outputFile);

        setActiveProcess(cmd);
    });
}

// ============================================================================
// AUDIO NORMALIZATION (only — when no silence found)
// ============================================================================

function normalizeAudioOnly(inputFile, outputFile, qualityPreset, event) {
    return new Promise((resolve, reject) => {
        if (isCancelled) return reject(new Error('Processing cancelled'));

        const encoding = getEncodingOptions(qualityPreset);
        const startTime = Date.now();

        const cmd = ffmpeg(inputFile)
            .outputOptions([
                '-c:v', 'copy',
                '-c:a', encoding.audioCodec,
                '-b:a', encoding.audioBitrate,
                '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
                '-threads', '0'
            ])
            .on('start', () => {
                event.reply('log', `⚙️ Normalizing audio...`);
                event.reply('progress', { status: 'Normalizing audio...', percent: 50 });
            })
            .on('progress', (progress) => {
                if (isCancelled) return;
                if (progress && typeof progress.percent === 'number' && !isNaN(progress.percent)) {
                    const pv = parseFloat(progress.percent);
                    if (pv >= 0 && pv <= 100) {
                        const finalPercent = Math.min(100, 50 + (pv / 2));
                        const elapsed = (Date.now() - startTime) / 1000;
                        let eta = '';
                        if (pv > 10 && elapsed > 2) {
                            const remaining = Math.max(0, (elapsed / (pv / 100)) - elapsed);
                            eta = remaining < 60
                                ? ` — ~${Math.round(remaining)}s remaining`
                                : ` — ~${Math.round(remaining / 60)}m ${Math.round(remaining % 60)}s remaining`;
                        }
                        event.reply('progress', { status: `Normalizing: ${pv.toFixed(1)}%${eta}`, percent: finalPercent });
                    }
                }
            })
            .on('end', () => {
                clearActiveProcess();
                event.reply('log', `✅ Audio normalized successfully`);
                resolve();
            })
            .on('error', (err) => {
                clearActiveProcess();
                if (isCancelled) reject(new Error('Processing cancelled'));
                else reject(err);
            })
            .save(outputFile);

        setActiveProcess(cmd);
    });
}

// ============================================================================
// SILENCE DETECTION (optimized with -vn: audio-only analysis)
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
    return {
        adjustedStart,
        adjustedEnd,
        duration: adjustedEnd - adjustedStart
    };
}

async function detectSilence(inputFile, params, event) {
    return new Promise((resolve, reject) => {
        if (isCancelled) return reject(new Error('Processing cancelled'));

        const silenceRanges = [];
        let startTime = null;

        event.reply('log', `🔍 Starting silence analysis (audio-only mode)...`);

        const cmd = ffmpeg(inputFile)
            .inputOptions(['-vn'])
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
                if (isCancelled) return reject(new Error('Processing cancelled'));
                clearActiveProcess();
                event.reply('log', `✅ Found ${silenceRanges.length} silence ranges`);
                resolve(silenceRanges);
            })
            .on('error', (err) => {
                clearActiveProcess();
                if (isCancelled) reject(new Error('Processing cancelled'));
                else reject(err);
            })
            .run();

        setActiveProcess(cmd);
    });
}

// ============================================================================
// VIDEO PROCESSING — ORCHESTRATOR
// ============================================================================

async function processVideo(inputFile, outputFile, silenceRanges, normalizeAudio, qualityPreset, event, useHardwareEncoder = true) {
    const metadata = await getVideoMetadata(inputFile);
    const inputDuration = metadata.format.duration;

    const talkingRanges = calculateTalkingRanges(silenceRanges, inputDuration);
    const stats = calculateDurationStats(silenceRanges, inputDuration);

    event.reply('log', `📊 Input: ${stats.inputDuration.toFixed(1)}s | Removing: ${stats.totalSilenceDuration.toFixed(1)}s | Expected: ${stats.expectedOutputDuration.toFixed(1)}s`);
    event.reply('log', `📦 Found ${talkingRanges.length} talking ranges`);
    event.reply('log', `🎨 Quality: ${qualityPreset}`);
    if (normalizeAudio) event.reply('log', `🔊 Audio normalization enabled (-16 LUFS)`);

    const tempDir = path.join(path.dirname(outputFile), TEMP_DIR_NAME);

    try {
        const filterGraph = buildFilterScript(talkingRanges, normalizeAudio);
        const filterScriptPath = await writeFilterScript(filterGraph, tempDir);

        event.reply('log', `🚀 Processing with filter_complex_script (${talkingRanges.length} segments)`);

        await processVideoWithFilter(inputFile, outputFile, filterScriptPath, qualityPreset, stats.expectedOutputDuration, event, useHardwareEncoder);

        event.reply('log', `✅ Video processing completed successfully`);
    } finally {
        try {
            await fs.remove(tempDir);
            event.reply('log', `🧹 Cleaned up temporary files`);
        } catch (e) {
            event.reply('log', `⚠️ Could not clean temp files: ${e.message}`);
        }
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

ipcMain.on('cancel-processing', (event) => {
    event.reply('log', `⚠️ Cancelling processing...`);
    cancelActiveProcess();
});

ipcMain.on('get-encoder-info', (event) => {
    if (detectedHWEncoder) {
        const descriptions = {
            videotoolbox: 'Apple VideoToolbox — hardware encode via macOS GPU',
            nvenc: 'NVIDIA NVENC — hardware encode via NVIDIA GPU',
            qsv: 'Intel Quick Sync — hardware encode via Intel GPU',
            amf: 'AMD AMF — hardware encode via AMD GPU'
        };
        event.reply('encoder-info', {
            available: true,
            name: detectedHWEncoder.codec,
            type: detectedHWEncoder.type,
            description: descriptions[detectedHWEncoder.type] || 'Hardware GPU encoder'
        });
    } else {
        event.reply('encoder-info', { available: false });
    }
});

ipcMain.on('start-processing', async (event, params) => {
    isCancelled = false;
    clearActiveProcess();

    try {
        const outputFile = path.join(
            params.outputPath,
            `processed_${path.basename(params.inputPath)}`
        );

        event.reply('progress', { status: 'Phase 1: Analyzing audio for silence...', percent: 0 });

        const silenceRanges = await detectSilence(params.inputPath, params, event);

        if (isCancelled) {
            event.reply('completed', { success: false, cancelled: true, outputFile: null });
            return;
        }

        if (silenceRanges.length === 0) {
            event.reply('log', `ℹ️ No silence found, processing file...`);
            event.reply('progress', { status: 'No silences detected — processing file...', percent: 50 });

            if (params.normalizeAudio) {
                event.reply('log', `🔊 Normalizing audio to -16 LUFS (YouTube standard)...`);
                await normalizeAudioOnly(params.inputPath, outputFile, params.qualityPreset || 'medium', event);
            } else {
                await fs.copyFile(params.inputPath, outputFile);
            }

            event.reply('progress', { status: 'Complete! No processing needed.', percent: 100 });
            event.reply('completed', { success: true, outputFile });
            return;
        }

        event.reply('progress', { status: 'Phase 2: Processing video (removing silences)...', percent: 0 });

        await processVideo(params.inputPath, outputFile, silenceRanges, params.normalizeAudio, params.qualityPreset || 'medium', event, params.useHardwareEncoder !== false);

        if (isCancelled) {
            try { await fs.remove(outputFile); } catch (e) { /* ignore */ }
            event.reply('completed', { success: false, cancelled: true, outputFile: null });
        } else {
            event.reply('completed', { success: true, outputFile });
        }
    } catch (error) {
        if (isCancelled || (error.message && error.message.includes('cancelled'))) {
            event.reply('log', `⚠️ Processing cancelled by user`);
            event.reply('completed', { success: false, cancelled: true, outputFile: null });
        } else {
            const errorMessage = error.message || 'Unknown error';
            event.reply('log', `❌ Error: ${errorMessage}`);
            event.reply('completed', { success: false, cancelled: false, error: errorMessage, outputFile: null });
        }
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
