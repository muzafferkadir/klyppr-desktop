const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { spawn, execFile } = require('child_process');

// ============================================================================
// CONSTANTS
// ============================================================================

Menu.setApplicationMenu(null);

const configPath = path.join(app.getPath('userData'), 'config.json');
const MIN_SEGMENT_DURATION = 0.05;
const TEMP_DIR_NAME = '.klyppr_temp';

// YouTube-standard loudness target (-16 LUFS)
const LOUDNORM_TARGET = 'I=-16:TP=-1.5:LRA=11';

const PLATFORM = {
    isWindows: process.platform === 'win32',
    isDevelopment: process.env.NODE_ENV === 'development'
};

const VIDEO_EXTENSIONS = [
    'mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'ts',
    'm4v', 'wmv', '3gp', 'mpg', 'mpeg', 'mts', 'vob'
];

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

// Resolved at startup
let FFMPEG_PATH = null;
let FFPROBE_PATH = null;

// Detected asynchronously after the window opens — null means software encoding
let detectedHWEncoder = null;
let hwDetectionPromise = null;

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
// FFMPEG RUNNER (spawn-based, replaces fluent-ffmpeg)
// ============================================================================

/**
 * Run ffmpeg with the given args. Streams stderr line-by-line (onLine) and
 * parses `time=` for progress (onProgress). Resolves with the full stderr text
 * (used by loudness measurement); rejects on non-zero exit or cancellation.
 */
function runFFmpeg(args, { onLine, onProgress } = {}) {
    return new Promise((resolve, reject) => {
        if (isCancelled) return reject(new Error('Processing cancelled'));

        const proc = spawn(FFMPEG_PATH, args);
        setActiveProcess(proc);

        let fullStderr = '';
        let lineBuffer = '';

        proc.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            fullStderr += text;

            if (onProgress) {
                const m = text.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
                if (m) {
                    const seconds = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
                    onProgress(seconds);
                }
            }

            if (onLine) {
                lineBuffer += text;
                let nl;
                while ((nl = lineBuffer.search(/\r?\n/)) !== -1) {
                    const line = lineBuffer.slice(0, nl);
                    const skip = (lineBuffer[nl] === '\r' && lineBuffer[nl + 1] === '\n') ? 2 : 1;
                    lineBuffer = lineBuffer.slice(nl + skip);
                    if (line) onLine(line);
                }
            }
        });

        proc.on('error', (err) => {
            clearActiveProcess();
            reject(err);
        });

        proc.on('close', (code) => {
            clearActiveProcess();
            if (onLine && lineBuffer) onLine(lineBuffer);
            if (isCancelled) return reject(new Error('Processing cancelled'));
            if (code === 0) resolve(fullStderr);
            else reject(new Error(`FFmpeg exited with code ${code}`));
        });
    });
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

function setupFFmpegBinaries() {
    const { ffmpeg: ffmpegPath, ffprobe: ffprobePath } = getFFmpegPaths();

    if (!fs.existsSync(ffmpegPath) || !fs.existsSync(ffprobePath)) {
        throw new Error('FFmpeg or FFprobe binaries not found.');
    }

    FFMPEG_PATH = ffmpegPath;
    FFPROBE_PATH = ffprobePath;
}

/**
 * Detect available hardware video encoders asynchronously (non-blocking).
 * Runs `ffmpeg -encoders` and checks for GPU-accelerated H.264 encoders.
 * Resolves to an encoder info object or null if none is available.
 */
function detectHardwareEncoderAsync() {
    return new Promise((resolve) => {
        execFile(FFMPEG_PATH, ['-hide_banner', '-encoders'],
            { timeout: 8000, maxBuffer: 5 * 1024 * 1024 },
            (err, stdout) => {
                if (err) {
                    console.log('💻 Hardware detection failed — using software encoding');
                    return resolve(null);
                }

                const output = stdout || '';
                const { isWindows } = PLATFORM;

                if (!isWindows) {
                    if (output.includes('h264_videotoolbox')) {
                        console.log('🎮 Hardware encoder detected: h264_videotoolbox (Apple GPU)');
                        return resolve({ codec: 'h264_videotoolbox', type: 'videotoolbox' });
                    }
                } else {
                    if (output.includes('h264_nvenc')) {
                        console.log('🎮 Hardware encoder detected: h264_nvenc (NVIDIA GPU)');
                        return resolve({ codec: 'h264_nvenc', type: 'nvenc' });
                    }
                    if (output.includes('h264_qsv')) {
                        console.log('🎮 Hardware encoder detected: h264_qsv (Intel GPU)');
                        return resolve({ codec: 'h264_qsv', type: 'qsv' });
                    }
                    if (output.includes('h264_amf')) {
                        console.log('🎮 Hardware encoder detected: h264_amf (AMD GPU)');
                        return resolve({ codec: 'h264_amf', type: 'amf' });
                    }
                }

                console.log('💻 No hardware encoder found — using software encoding');
                resolve(null);
            });
    });
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
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
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
        execFile(FFPROBE_PATH,
            ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', inputFile],
            { maxBuffer: 20 * 1024 * 1024 },
            (err, stdout) => {
                if (err) return reject(err);
                try {
                    const meta = JSON.parse(stdout);
                    if (meta.format && meta.format.duration != null) {
                        meta.format.duration = parseFloat(meta.format.duration);
                    }
                    resolve(meta);
                } catch (e) {
                    reject(new Error('Could not parse ffprobe output'));
                }
            });
    });
}

function hasAudioStream(metadata) {
    return !!(metadata && metadata.streams && metadata.streams.some(s => s.codec_type === 'audio'));
}

function getFrameRate(metadata) {
    const v = metadata.streams && metadata.streams.find(s => s.codec_type === 'video');
    if (!v) return 30;
    const rate = v.r_frame_rate || v.avg_frame_rate;
    if (!rate) return 30;
    const [num, den] = rate.split('/').map(Number);
    const fps = den ? num / den : num;
    return (fps && isFinite(fps) && fps > 0) ? fps : 30;
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
    const preset = qualityPreset || 'medium';

    // Lossless always uses the software encoder — hardware encoders don't do true lossless
    if (preset === 'lossless') {
        return {
            videoCodec: 'libx264',
            videoQuality: ['-preset', 'slow', '-crf', '0'],
            audioCodec: 'aac',
            audioBitrate: '320k',
            isHardware: false
        };
    }

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
            audioCodec: 'aac',
            audioBitrate: '128k',
            isHardware: true
        };
    }

    // Software encoding fallback
    return {
        videoCodec: 'libx264',
        videoQuality: preset === 'fast' ? ['-preset', 'ultrafast', '-crf', '28'] :
            preset === 'high' ? ['-preset', 'medium', '-crf', '18'] :
                ['-preset', 'veryfast', '-crf', '23'],
        audioCodec: 'aac',
        audioBitrate: '128k',
        isHardware: false
    };
}

// ============================================================================
// AUDIO LOUDNESS (two-pass loudnorm helpers)
// ============================================================================

/**
 * Pass 1: measure loudness stats with loudnorm print_format=json.
 * Silence gating in loudnorm means measuring the original (uncut) audio is
 * effectively identical to measuring the cut result, so we skip the extra cut.
 * Returns the parsed stats object, or null if measurement/parsing failed.
 */
async function measureLoudness(inputFile) {
    const args = [
        '-hide_banner', '-vn', '-i', inputFile,
        '-af', `loudnorm=${LOUDNORM_TARGET}:print_format=json`,
        '-f', 'null', '-'
    ];
    const stderr = await runFFmpeg(args, {});
    const open = stderr.lastIndexOf('{');
    const close = stderr.lastIndexOf('}');
    if (open === -1 || close <= open) return null;
    try {
        const stats = JSON.parse(stderr.slice(open, close + 1));
        return (stats && stats.input_i != null) ? stats : null;
    } catch (e) {
        return null;
    }
}

/**
 * Build the pass-2 loudnorm filter string using measured stats (linear mode).
 * Falls back to single-pass loudnorm when measurement is unavailable.
 */
function buildLoudnormFilter(measured) {
    if (!measured) return `loudnorm=${LOUDNORM_TARGET}`;
    return `loudnorm=${LOUDNORM_TARGET}` +
        `:measured_I=${measured.input_i}` +
        `:measured_TP=${measured.input_tp}` +
        `:measured_LRA=${measured.input_lra}` +
        `:measured_thresh=${measured.input_thresh}` +
        `:offset=${measured.target_offset}` +
        `:linear=true`;
}

// ============================================================================
// FILTER SCRIPT GENERATION (trim/atrim + concat)
// ============================================================================

function buildFilterScript(talkingRanges, normalizeAudio, loudnormFilter) {
    const filterParts = talkingRanges.map((r, i) =>
        `[0:v]trim=start=${r.start.toFixed(4)}:end=${r.end.toFixed(4)},setpts=PTS-STARTPTS[v${i}];` +
        `[0:a]atrim=start=${r.start.toFixed(4)}:end=${r.end.toFixed(4)},asetpts=PTS-STARTPTS[a${i}]`
    );

    const concatInputs = talkingRanges.map((_, i) => `[v${i}][a${i}]`).join('');

    let filterGraph = filterParts.join(';') + ';' + concatInputs +
        `concat=n=${talkingRanges.length}:v=1:a=1`;

    if (normalizeAudio) {
        const ln = loudnormFilter || `loudnorm=${LOUDNORM_TARGET}`;
        filterGraph += `[tmpv][tmpa];[tmpv]copy[outv];[tmpa]${ln}[outa]`;
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

function formatEta(percent, elapsed) {
    if (!(percent > 5 && elapsed > 2)) return '';
    const remaining = Math.max(0, (elapsed / (percent / 100)) - elapsed);
    return remaining < 60
        ? ` — ~${Math.round(remaining)}s remaining`
        : ` — ~${Math.round(remaining / 60)}m ${Math.round(remaining % 60)}s remaining`;
}

// ============================================================================
// VIDEO PROCESSING (trim+atrim+concat via filter_complex_script)
// ============================================================================

async function processVideoWithFilter(inputFile, outputFile, filterScriptPath, qualityPreset, expectedDuration, gopSize, event, useHardwareEncoder = true) {
    if (isCancelled) throw new Error('Processing cancelled');

    const encoding = getEncodingOptions(qualityPreset, useHardwareEncoder);
    const args = [
        '-hide_banner',
        '-i', inputFile,
        '-filter_complex_script', filterScriptPath,
        '-map', '[outv]',
        '-map', '[outa]',
        '-map_metadata', '0',
        '-c:v', encoding.videoCodec,
        ...encoding.videoQuality,
        '-pix_fmt', 'yuv420p',
        ...(gopSize ? ['-g', String(gopSize)] : []),
        '-c:a', encoding.audioCodec,
        '-b:a', encoding.audioBitrate,
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        '-threads', '0',
        '-y', outputFile
    ];

    event.reply('log', encoding.isHardware
        ? `🎮 Using hardware encoder: ${encoding.videoCodec}`
        : `💻 Using software encoder: ${encoding.videoCodec}`);
    event.reply('log', `⚙️ FFmpeg: ${FFMPEG_PATH} ${args.join(' ')}`);

    const startTime = Date.now();

    await runFFmpeg(args, {
        onProgress: (currentTime) => {
            if (isCancelled) return;
            let percent = Math.round((currentTime / expectedDuration) * 100);
            if (!isFinite(percent) || percent < 0) percent = 0;
            percent = Math.min(99, percent);
            const elapsed = (Date.now() - startTime) / 1000;
            event.reply('progress', { status: `Processing: ${percent}%${formatEta(percent, elapsed)}`, percent });
        }
    });

    event.reply('progress', { status: 'Processing: 100% — Complete!', percent: 100 });
}

// ============================================================================
// AUDIO NORMALIZATION ONLY (when no silence found)
// ============================================================================

async function normalizeAudioOnly(inputFile, outputFile, qualityPreset, event, metadata) {
    if (isCancelled) throw new Error('Processing cancelled');

    const inputDuration = metadata ? parseFloat(metadata.format.duration) : 0;

    event.reply('log', `🔊 Measuring loudness (pass 1/2)...`);
    let measured = null;
    try {
        measured = await measureLoudness(inputFile);
    } catch (e) { /* fall back to single-pass */ }
    if (isCancelled) throw new Error('Processing cancelled');

    const loudnormFilter = buildLoudnormFilter(measured);
    event.reply('log', measured
        ? `✅ Loudness measured (I=${measured.input_i} LUFS) — applying (pass 2/2)`
        : `⚠️ Measurement unavailable — using single-pass loudnorm`);

    const encoding = getEncodingOptions(qualityPreset);
    const args = [
        '-hide_banner',
        '-i', inputFile,
        '-c:v', 'copy',
        '-c:a', encoding.audioCodec,
        '-b:a', encoding.audioBitrate,
        '-af', loudnormFilter,
        '-map_metadata', '0',
        '-threads', '0',
        '-y', outputFile
    ];

    const startTime = Date.now();
    event.reply('progress', { status: 'Normalizing audio...', percent: 50 });

    await runFFmpeg(args, {
        onProgress: (currentTime) => {
            if (isCancelled || !inputDuration) return;
            const pv = Math.min(100, (currentTime / inputDuration) * 100);
            const finalPercent = Math.min(100, 50 + (pv / 2));
            const elapsed = (Date.now() - startTime) / 1000;
            event.reply('progress', { status: `Normalizing: ${pv.toFixed(1)}%${formatEta(pv, elapsed)}`, percent: finalPercent });
        }
    });

    event.reply('log', `✅ Audio normalized successfully`);
}

// ============================================================================
// SILENCE DETECTION (optimized with -vn: audio-only analysis)
// ============================================================================

function parseSilenceLine(line) {
    const silenceStart = line.match(/silence_start: (-?[\d.]+)/);
    const silenceEnd = line.match(/silence_end: (-?[\d.]+)/);
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
    if (isCancelled) throw new Error('Processing cancelled');

    const silenceRanges = [];
    let startTime = null;

    event.reply('log', `🔍 Starting silence analysis (audio-only mode)...`);

    const args = [
        '-hide_banner', '-vn', '-i', inputFile,
        '-af', `silencedetect=noise=${params.silenceDb}dB:d=${params.minSilenceDuration}`,
        '-f', 'null', '-'
    ];
    event.reply('log', `⚙️ FFmpeg: ${FFMPEG_PATH} ${args.join(' ')}`);

    await runFFmpeg(args, {
        onLine: (line) => {
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
        }
    });

    event.reply('log', `✅ Found ${silenceRanges.length} silence ranges`);
    return silenceRanges;
}

// ============================================================================
// VIDEO PROCESSING — ORCHESTRATOR
// ============================================================================

async function processVideo(inputFile, outputFile, silenceRanges, normalizeAudio, qualityPreset, event, useHardwareEncoder, metadata) {
    const inputDuration = parseFloat(metadata.format.duration);

    const talkingRanges = calculateTalkingRanges(silenceRanges, inputDuration);
    const stats = calculateDurationStats(silenceRanges, inputDuration);
    const gopSize = Math.max(1, Math.round(getFrameRate(metadata) * 2));

    event.reply('log', `📊 Input: ${stats.inputDuration.toFixed(1)}s | Removing: ${stats.totalSilenceDuration.toFixed(1)}s | Expected: ${stats.expectedOutputDuration.toFixed(1)}s`);
    event.reply('log', `📦 Found ${talkingRanges.length} talking ranges`);
    event.reply('log', `🎨 Quality: ${qualityPreset}`);
    if (talkingRanges.length > 400) {
        event.reply('log', `⚠️ High segment count (${talkingRanges.length}) — encoding a single large filtergraph may be slow`);
    }

    let loudnormFilter = null;
    if (normalizeAudio) {
        event.reply('log', `🔊 Audio normalization enabled (-16 LUFS, two-pass)`);
        event.reply('log', `🔊 Measuring loudness (pass 1/2)...`);
        try {
            const measured = await measureLoudness(inputFile);
            loudnormFilter = buildLoudnormFilter(measured);
            event.reply('log', measured
                ? `✅ Loudness measured (I=${measured.input_i} LUFS)`
                : `⚠️ Measurement unavailable — using single-pass loudnorm`);
        } catch (e) {
            event.reply('log', `⚠️ Measurement error — using single-pass loudnorm`);
        }
        if (isCancelled) throw new Error('Processing cancelled');
    }

    const tempDir = path.join(path.dirname(outputFile), TEMP_DIR_NAME);

    try {
        const filterGraph = buildFilterScript(talkingRanges, normalizeAudio, loudnormFilter);
        const filterScriptPath = await writeFilterScript(filterGraph, tempDir);

        event.reply('log', `🚀 Processing ${normalizeAudio ? '(pass 2/2) ' : ''}with filter_complex_script (${talkingRanges.length} segments)`);

        await processVideoWithFilter(inputFile, outputFile, filterScriptPath, qualityPreset, stats.expectedOutputDuration, gopSize, event, useHardwareEncoder);

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
        filters: [{ name: 'Video Files', extensions: VIDEO_EXTENSIONS }]
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

ipcMain.on('get-encoder-info', async (event) => {
    if (hwDetectionPromise) {
        try { await hwDetectionPromise; } catch (e) { /* ignore */ }
    }

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

        const metadata = await getVideoMetadata(params.inputPath);

        // No audio stream → silence removal / normalization is meaningless
        if (!hasAudioStream(metadata)) {
            event.reply('log', `⚠️ No audio stream found — copying video as-is`);
            await fs.copyFile(params.inputPath, outputFile);
            event.reply('progress', { status: 'Complete! (no audio to process)', percent: 100 });
            event.reply('completed', { success: true, outputFile });
            return;
        }

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
                await normalizeAudioOnly(params.inputPath, outputFile, params.qualityPreset || 'medium', event, metadata);
            } else {
                await fs.copyFile(params.inputPath, outputFile);
            }

            if (isCancelled) {
                try { await fs.remove(outputFile); } catch (e) { /* ignore */ }
                event.reply('completed', { success: false, cancelled: true, outputFile: null });
                return;
            }

            event.reply('progress', { status: 'Complete! No processing needed.', percent: 100 });
            event.reply('completed', { success: true, outputFile });
            return;
        }

        event.reply('progress', { status: 'Phase 2: Processing video (removing silences)...', percent: 0 });

        await processVideo(params.inputPath, outputFile, silenceRanges, params.normalizeAudio, params.qualityPreset || 'medium', event, params.useHardwareEncoder !== false, metadata);

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

ipcMain.on('save-settings', (event, settings) => {
    const config = loadConfig();
    config.settings = settings;
    saveConfig(config);
});

ipcMain.handle('load-settings', () => {
    const config = loadConfig();
    return config.settings || null;
});

// ============================================================================
// APP INITIALIZATION
// ============================================================================

app.whenReady().then(async () => {
    try {
        setupFFmpegBinaries();
        createWindow();

        // Detect GPU encoder in the background so the window opens instantly
        hwDetectionPromise = detectHardwareEncoderAsync().then((enc) => {
            detectedHWEncoder = enc;
            return enc;
        });
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
