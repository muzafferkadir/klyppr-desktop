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
    videotoolbox: { fast: 35, medium: 55, high: 75, lossless: 90 },
    // NVENC (NVIDIA) — uses CQ value (lower = better, like CRF)
    nvenc: { fast: 32, medium: 24, high: 18, lossless: 16 },
    // QSV (Intel) — uses global_quality
    qsv: { fast: 32, medium: 24, high: 18, lossless: 16 },
    // AMF (AMD) — uses quality level
    amf: { fast: 32, medium: 24, high: 18, lossless: 16 }
};

// Map the INPUT video codec to a matching encoder per backend, so the output keeps
// the same codec it came in with (h264 in → h264 out, hevc in → hevc out, …).
const VIDEO_ENCODERS = {
    h264: { sw: 'libx264', nvenc: 'h264_nvenc', videotoolbox: 'h264_videotoolbox', qsv: 'h264_qsv', amf: 'h264_amf' },
    hevc: { sw: 'libx265', nvenc: 'hevc_nvenc', videotoolbox: 'hevc_videotoolbox', qsv: 'hevc_qsv', amf: 'hevc_amf' },
    vp9:  { sw: 'libvpx-vp9' },
    av1:  { sw: 'libsvtav1' },
    mpeg4: { sw: 'mpeg4' }
};

// Map the INPUT audio codec to a matching encoder, so audio stays the same codec.
const AUDIO_ENCODERS = {
    aac: 'aac', mp3: 'libmp3lame', opus: 'libopus', vorbis: 'libvorbis',
    ac3: 'ac3', eac3: 'eac3', flac: 'flac', alac: 'alac',
    pcm_s16le: 'pcm_s16le', pcm_s24le: 'pcm_s24le'
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
            else {
                const tail = fullStderr.trim().split('\n').slice(-3).join(' | ');
                reject(new Error(`FFmpeg exited with code ${code}${tail ? `: ${tail}` : ''}`));
            }
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
    const isMac = process.platform === 'darwin';
    mainWindow = new BrowserWindow({
        width: 1160,
        height: 620,
        minWidth: 720,
        minHeight: 520,
        show: false,
        titleBarStyle: isMac ? 'hiddenInset' : 'default',
        trafficLightPosition: isMac ? { x: 18, y: 20 } : undefined,
        vibrancy: isMac ? 'under-window' : undefined,
        visualEffectState: 'active',
        backgroundColor: isMac ? '#00000000' : '#1e1e1e',
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

// Pull the input's real codec/pixel-format/audio params so we can reproduce them on
// output instead of imposing our own. "As it went in, so it comes out."
function extractStreamInfo(metadata) {
    const streams = (metadata && metadata.streams) || [];
    const v = streams.find(s => s.codec_type === 'video') || {};
    const a = streams.find(s => s.codec_type === 'audio') || {};
    const abr = parseInt(a.bit_rate, 10);
    return {
        vcodec: (v.codec_name || 'h264').toLowerCase(),
        pixFmt: v.pix_fmt || 'yuv420p',
        acodec: (a.codec_name || 'aac').toLowerCase(),
        // keep the source audio bitrate when known (rounded to kbps), else a safe default
        abitrate: (abr && isFinite(abr)) ? `${Math.round(abr / 1000)}k` : null
    };
}

function getFrameRate(metadata) {
    const v = metadata.streams && metadata.streams.find(s => s.codec_type === 'video');
    if (!v) return 30;
    const parse = (rate) => {
        if (!rate) return null;
        const [num, den] = rate.split('/').map(Number);
        const fps = den ? num / den : num;
        return (fps && isFinite(fps) && fps > 0) ? fps : null;
    };
    // r_frame_rate is the *maximum* rate and is frequently inflated on TS/AVI
    // (e.g. 90 or 90000 where the real rate is 30). Trust avg_frame_rate when r
    // looks inflated relative to it, then clamp to a sane 5–240 range so we never
    // emit -r 90000 / -g 180000 and blow up the encoder.
    const r = parse(v.r_frame_rate);
    const avg = parse(v.avg_frame_rate);
    let fps = (r && avg && r > avg * 1.5) ? avg : (r || avg || 30);
    return Math.min(240, Math.max(5, fps));
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

function getEncodingOptions(qualityPreset = 'medium', useHardwareEncoder = true, streamInfo = null) {
    const preset = qualityPreset || 'medium';
    const isHigh = preset === 'high' || preset === 'lossless';
    const info = streamInfo || {};

    // Reproduce the INPUT's own formats instead of imposing ours:
    //   - video encoder matches the input codec (h264→libx264/…, hevc→libx265/…)
    //   - pixel format is carried through unchanged (keeps 4:2:0 as 4:2:0, etc.)
    //   - audio keeps its codec and (when known) its bitrate
    const inVcodec = (info.vcodec || 'h264').toLowerCase();
    const pixFmt = info.pixFmt || 'yuv420p';
    const audioCodec = AUDIO_ENCODERS[(info.acodec || 'aac').toLowerCase()] || 'aac';
    const audioBitrate = info.abitrate || '320k';
    const family = VIDEO_ENCODERS[inVcodec] || VIDEO_ENCODERS.h264;

    // HEVC must be tagged 'hvc1' or Apple players (QuickTime, Preview, iOS) refuse
    // to play it — FFmpeg's default 'hev1' tag shows a black/blank video there.
    const videoTag = inVcodec === 'hevc' ? ['-tag:v', 'hvc1'] : [];

    // Quality knob per preset. NEVER crf 0 — libx264 tags true-lossless as
    // "High 4:4:4 Predictive", which hardware/software players render as a black screen.
    // We do NOT pass -profile:v; the encoder derives the right profile from pixFmt.
    const crf = preset === 'fast' ? 28 : preset === 'high' ? 18 : preset === 'lossless' ? 16 : 23;

    // GPU path — only when this GPU actually has an encoder for the input's codec.
    if (detectedHWEncoder && useHardwareEncoder && family[detectedHWEncoder.type]) {
        const hwQuality = HW_QUALITY_SETTINGS[detectedHWEncoder.type] || {};
        const qVal = hwQuality[preset] || hwQuality.high || hwQuality.medium;
        let videoQuality;
        switch (detectedHWEncoder.type) {
            case 'videotoolbox':
                videoQuality = ['-q:v', String(qVal)];
                break;
            case 'nvenc':
                videoQuality = ['-preset', preset === 'fast' ? 'p1' : isHigh ? 'p7' : 'p4', '-cq', String(qVal), '-rc', 'vbr'];
                break;
            case 'qsv':
                videoQuality = ['-global_quality', String(qVal), '-look_ahead', '1'];
                break;
            case 'amf':
                videoQuality = ['-quality', preset === 'fast' ? 'speed' : isHigh ? 'quality' : 'balanced', '-qp_i', String(qVal), '-qp_p', String(qVal)];
                break;
            default:
                videoQuality = ['-q:v', String(qVal)];
        }
        return { videoCodec: family[detectedHWEncoder.type], videoQuality, videoTag, pixFmt, audioCodec, audioBitrate, isHardware: true };
    }

    // Software path — encoder matches the input codec family.
    const sw = family.sw || 'libx264';
    let videoQuality;
    if (sw === 'libvpx-vp9') {
        videoQuality = ['-crf', String(crf), '-b:v', '0'];
    } else if (sw === 'libx265') {
        videoQuality = ['-preset', preset === 'fast' ? 'veryfast' : isHigh ? 'medium' : 'fast', '-crf', String(crf)];
    } else if (sw === 'libsvtav1') {
        videoQuality = ['-crf', String(crf), '-preset', preset === 'fast' ? '10' : '6'];
    } else if (sw === 'mpeg4') {
        videoQuality = ['-q:v', preset === 'fast' ? '6' : isHigh ? '2' : '4'];
    } else {
        // libx264
        videoQuality = ['-preset', preset === 'fast' ? 'veryfast' : isHigh ? 'medium' : 'veryfast', '-crf', String(crf)];
    }
    return { videoCodec: sw, videoQuality, videoTag, pixFmt, audioCodec, audioBitrate, isHardware: false };
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

function buildFilterScript(talkingRanges, normalizeAudio, loudnormFilter, fps) {
    // Snap every cut to the frame grid so each segment's trimmed VIDEO and AUDIO
    // have the same duration. Otherwise video trim is frame-quantized while audio
    // atrim is sample-exact; the per-segment mismatch accumulates across cuts into
    // a growing A/V drift (lip-sync slips further out the longer the video runs).
    // Full precision (NOT toFixed) — at NTSC rates (29.97/59.94/23.976) a frame time
    // rounds up at 4 decimals and trim's exact PTS compare would then drop that frame.
    const snap = (t) => (fps > 0) ? Math.round(t * fps) / fps : t;
    const filterParts = talkingRanges.map((r, i) => {
        const start = String(snap(r.start));
        const end = String(snap(r.end));
        // fps=… first forces the (possibly VFR) source onto a constant grid BEFORE
        // trimming, so the snapped cut points actually land on real frames — iPhone
        // and screen recordings are variable frame rate and would otherwise drift.
        return `[0:v]fps=${fps},trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}];` +
            `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}]`;
    });

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

async function processVideoWithFilter(inputFile, outputFile, filterScriptPath, qualityPreset, expectedDuration, gopSize, event, useHardwareEncoder = true, streamInfo = null, fps = null) {
    if (isCancelled) throw new Error('Processing cancelled');

    const encoding = getEncodingOptions(qualityPreset, useHardwareEncoder, streamInfo);
    // hvc1 tag and +faststart are ISO-BMFF (MP4/MOV) muxer options — MKV/WebM/AVI
    // reject them ('movflags' hard-fails there). Only emit them for those containers.
    const isIsoBmff = /\.(mp4|mov|m4v)$/i.test(outputFile);
    const args = [
        '-hide_banner',
        '-i', inputFile,
        '-/filter_complex', filterScriptPath,
        '-map', '[outv]',
        '-map', '[outa]',
        '-map_metadata', '0',
        '-c:v', encoding.videoCodec,
        ...encoding.videoQuality,
        ...(isIsoBmff ? encoding.videoTag : []),
        '-pix_fmt', encoding.pixFmt,
        // Force constant frame rate so the concatenated output has a single, even
        // frame grid — VFR input would otherwise reintroduce A/V drift after concat.
        ...(fps ? ['-r', String(fps), '-fps_mode', 'cfr'] : []),
        ...(gopSize ? ['-g', String(gopSize)] : []),
        '-c:a', encoding.audioCodec,
        '-b:a', encoding.audioBitrate,
        '-avoid_negative_ts', 'make_zero',
        ...(isIsoBmff ? ['-movflags', '+faststart'] : []),
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

    const encoding = getEncodingOptions(qualityPreset, false, extractStreamInfo(metadata));
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
    const streamInfo = extractStreamInfo(metadata);

    const talkingRanges = calculateTalkingRanges(silenceRanges, inputDuration);
    const stats = calculateDurationStats(silenceRanges, inputDuration);
    const fps = getFrameRate(metadata);
    const gopSize = Math.max(1, Math.round(fps * 2));

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
        const filterGraph = buildFilterScript(talkingRanges, normalizeAudio, loudnormFilter, fps);
        const filterScriptPath = await writeFilterScript(filterGraph, tempDir);

        event.reply('log', `🚀 Processing ${normalizeAudio ? '(pass 2/2) ' : ''}with filter_complex_script (${talkingRanges.length} segments)`);

        await processVideoWithFilter(inputFile, outputFile, filterScriptPath, qualityPreset, stats.expectedOutputDuration, gopSize, event, useHardwareEncoder, streamInfo, fps);

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
    app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
