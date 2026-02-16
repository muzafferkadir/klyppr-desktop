/**
 * Klyppr Desktop — Manual Test Suite
 * 
 * Tests the core processing functions without Electron runtime.
 * Uses the project's bundled ffmpeg/ffprobe binaries.
 * 
 * Usage: node test.js
 */

const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');

// ============================================================================
// CONFIG
// ============================================================================

const TEST_VIDEO = path.join(__dirname, 'videos', '1.mp4');
const OUTPUT_DIR = path.join(__dirname, 'videos', 'test_output');
const TEMP_DIR = path.join(OUTPUT_DIR, '.klyppr_temp');

// Try to find ffmpeg binaries
const isMac = process.platform === 'darwin';
const binDir = path.join(__dirname, 'bin', isMac ? 'mac' : 'win');
const systemFfmpeg = '/opt/homebrew/bin/ffmpeg';
const systemFfprobe = '/opt/homebrew/bin/ffprobe';

// Use bundled if exists, else system
const ffmpegPath = fs.existsSync(path.join(binDir, 'ffmpeg'))
    ? path.join(binDir, 'ffmpeg')
    : systemFfmpeg;
const ffprobePath = fs.existsSync(path.join(binDir, 'ffprobe'))
    ? path.join(binDir, 'ffprobe')
    : systemFfprobe;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

console.log(`📍 FFmpeg: ${ffmpegPath}`);
console.log(`📍 FFprobe: ${ffprobePath}`);
console.log(`📍 Test video: ${TEST_VIDEO}`);
console.log('');

// ============================================================================
// CONSTANTS (from main.js)
// ============================================================================

const MIN_SEGMENT_DURATION = 0.05;

const QUALITY_SETTINGS = {
    fast: { preset: 'ultrafast', crf: 28, qv: 6 },
    medium: { preset: 'veryfast', crf: 23, qv: 5 },
    high: { preset: 'medium', crf: 18, qv: 3 }
};

// ============================================================================
// FUNCTIONS UNDER TEST (copied from main.js for isolation)
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

function getEncodingOptions(qualityPreset = 'medium') {
    const quality = QUALITY_SETTINGS[qualityPreset] || QUALITY_SETTINGS.medium;
    return {
        videoCodec: 'libx264',
        videoQuality: ['-preset', quality.preset, '-crf', quality.crf.toString()],
        audioCodec: 'aac',
        audioBitrate: '128k',
        extraOptions: ['-movflags', '+faststart']
    };
}

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

function buildFilterScript(talkingRanges, normalizeAudio) {
    // Use trim/atrim + concat approach (select/aselect has audio timestamp bug)
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

// ============================================================================
// TEST HELPERS
// ============================================================================

let testCount = 0;
let passCount = 0;
let failCount = 0;

function assert(condition, message) {
    testCount++;
    if (condition) {
        passCount++;
        console.log(`  ✅ ${message}`);
    } else {
        failCount++;
        console.log(`  ❌ FAIL: ${message}`);
    }
}

function section(name) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🧪 ${name}`);
    console.log('='.repeat(60));
}

// ============================================================================
// TESTS
// ============================================================================

async function test_01_videoMetadata() {
    section('Test 1: Video Metadata (ffprobe)');

    const start = Date.now();
    const metadata = await getVideoMetadata(TEST_VIDEO);
    const elapsed = Date.now() - start;

    assert(metadata.format.duration > 0, `Duration: ${parseFloat(metadata.format.duration).toFixed(1)}s`);
    assert(metadata.streams.length >= 2, `Streams: ${metadata.streams.length} (video + audio)`);

    const videoStream = metadata.streams.find(s => s.codec_type === 'video');
    const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

    assert(videoStream !== undefined, `Video codec: ${videoStream?.codec_name}`);
    assert(audioStream !== undefined, `Audio codec: ${audioStream?.codec_name}`);
    assert(elapsed < 5000, `Metadata read in ${elapsed}ms`);

    return metadata;
}

async function test_02_silenceDetection() {
    section('Test 2: Silence Detection (with -vn optimization)');

    const params = {
        silenceDb: '-35',
        minSilenceDuration: '0.5',
        paddingDuration: '0.05'
    };

    const start = Date.now();

    const silenceRanges = await new Promise((resolve, reject) => {
        const ranges = [];
        let startTime = null;

        ffmpeg(TEST_VIDEO)
            .inputOptions(['-vn'])     // Audio-only — the optimization we're testing
            .outputOptions(['-f', 'null'])
            .audioFilters(`silencedetect=noise=${params.silenceDb}dB:d=${params.minSilenceDuration}`)
            .output('-')
            .on('stderr', line => {
                const { start, end } = parseSilenceLine(line);

                if (start !== null) startTime = start;

                if (end !== null && startTime !== null) {
                    const paddingDur = parseFloat(params.paddingDuration);
                    const { adjustedStart, adjustedEnd, duration } = processSilenceRange(startTime, end, paddingDur);

                    if (duration > MIN_SEGMENT_DURATION) {
                        ranges.push({ start: adjustedStart, end: adjustedEnd });
                    }
                    startTime = null;
                }
            })
            .on('end', () => resolve(ranges))
            .on('error', reject)
            .run();
    });

    const elapsed = Date.now() - start;

    assert(silenceRanges.length > 0, `Found ${silenceRanges.length} silence ranges`);
    assert(silenceRanges.every(r => r.start < r.end), 'All ranges have start < end');
    assert(silenceRanges.every(r => r.start >= 0), 'All ranges have non-negative start');
    assert(elapsed < 30000, `Detection took ${(elapsed / 1000).toFixed(1)}s (with -vn)`);

    // Check ranges are sorted
    let sorted = true;
    for (let i = 1; i < silenceRanges.length; i++) {
        if (silenceRanges[i].start <= silenceRanges[i - 1].start) {
            sorted = false;
            break;
        }
    }
    assert(sorted, 'Silence ranges are chronologically sorted');

    console.log(`  📊 First 5 ranges: ${silenceRanges.slice(0, 5).map(r => `${r.start.toFixed(2)}-${r.end.toFixed(2)}`).join(', ')}`);

    return silenceRanges;
}

async function test_03_talkingRanges(silenceRanges) {
    section('Test 3: Talking Range Calculation');

    const metadata = await getVideoMetadata(TEST_VIDEO);
    const duration = parseFloat(metadata.format.duration);

    const talkingRanges = calculateTalkingRanges(silenceRanges, duration);

    assert(talkingRanges.length > 0, `Found ${talkingRanges.length} talking ranges`);
    assert(talkingRanges.every(r => r.start < r.end), 'All talking ranges have start < end');
    assert(talkingRanges.every(r => (r.end - r.start) > MIN_SEGMENT_DURATION), 'All segments > minimum duration');

    // No overlaps
    let noOverlaps = true;
    for (let i = 1; i < talkingRanges.length; i++) {
        if (talkingRanges[i].start < talkingRanges[i - 1].end) {
            noOverlaps = false;
            break;
        }
    }
    assert(noOverlaps, 'Talking ranges do not overlap');

    const stats = calculateDurationStats(silenceRanges, duration);
    assert(stats.expectedOutputDuration > 0, `Expected output: ${stats.expectedOutputDuration.toFixed(1)}s`);
    assert(stats.expectedOutputDuration < duration, `Output (${stats.expectedOutputDuration.toFixed(1)}s) < Input (${duration.toFixed(1)}s)`);
    assert(stats.totalSilenceDuration > 0, `Silence removed: ${stats.totalSilenceDuration.toFixed(1)}s`);

    console.log(`  📊 Input: ${duration.toFixed(1)}s → Output: ${stats.expectedOutputDuration.toFixed(1)}s (removing ${stats.totalSilenceDuration.toFixed(1)}s silence)`);

    return talkingRanges;
}

async function test_04_filterScript(talkingRanges) {
    section('Test 4: Filter Script Generation (trim/atrim+concat)');

    // Without normalization
    const script1 = buildFilterScript(talkingRanges, false);
    assert(script1.includes('[0:v]trim='), 'Contains video trim filter');
    assert(script1.includes('[0:a]atrim='), 'Contains audio atrim filter');
    assert(script1.includes('setpts=PTS-STARTPTS'), 'Has video PTS reset');
    assert(script1.includes('asetpts=PTS-STARTPTS'), 'Has audio PTS reset');
    assert(script1.includes('concat=n='), 'Has concat filter');
    assert(!script1.includes('loudnorm'), 'No loudnorm when normalizeAudio=false');
    assert(script1.includes('[outv]'), 'Has [outv] output label');
    assert(script1.includes('[outa]'), 'Has [outa] output label');

    // With normalization
    const script2 = buildFilterScript(talkingRanges, true);
    assert(script2.includes('loudnorm=I=-16:TP=-1.5:LRA=11'), 'Has loudnorm when normalizeAudio=true');
    assert(script2.includes('[tmpv][tmpa]'), 'Uses intermediate labels for normalization');

    // Test writing to file
    await fs.ensureDir(TEMP_DIR);
    const scriptPath = path.join(TEMP_DIR, 'filter_script.txt');
    await fs.writeFile(scriptPath, script1, 'utf8');
    const readBack = await fs.readFile(scriptPath, 'utf8');
    assert(readBack === script1, 'Filter script written and read back correctly');

    // Check script length
    console.log(`  📊 Script length: ${script1.length} chars for ${talkingRanges.length} segments`);

    // Cleanup
    await fs.remove(TEMP_DIR);

    return script1;
}

async function test_05_singlePassProcessing(talkingRanges) {
    section('Test 5: Single-Pass Processing (filter_complex_script)');

    await fs.ensureDir(OUTPUT_DIR);
    await fs.ensureDir(TEMP_DIR);

    const metadata = await getVideoMetadata(TEST_VIDEO);
    const inputDuration = parseFloat(metadata.format.duration);

    // Build and write filter script
    const filterGraph = buildFilterScript(talkingRanges, false);
    const scriptPath = path.join(TEMP_DIR, 'filter_script.txt');
    await fs.writeFile(scriptPath, filterGraph, 'utf8');

    const outputFile = path.join(OUTPUT_DIR, 'test_output_no_normalize.mp4');
    const encoding = getEncodingOptions('fast');

    const stats = calculateDurationStats(
        // Reconstruct silence ranges from talking ranges for stats
        [], inputDuration
    );

    const start = Date.now();

    await new Promise((resolve, reject) => {
        const outputOptions = [
            '-filter_complex_script', scriptPath,
            '-map', '[outv]',
            '-map', '[outa]',
            '-c:v', encoding.videoCodec,
            ...encoding.videoQuality,
            '-c:a', encoding.audioCodec,
            '-b:a', encoding.audioBitrate,
            '-avoid_negative_ts', 'make_zero'
        ];
        if (encoding.extraOptions) outputOptions.push(...encoding.extraOptions);

        ffmpeg(TEST_VIDEO)
            .outputOptions(outputOptions)
            .on('start', cmd => {
                console.log(`  ⚙️ FFmpeg command started`);
            })
            .on('progress', progress => {
                if (progress && progress.timemark) {
                    process.stdout.write(`\r  ⏳ Processing... timemark: ${progress.timemark}    `);
                }
            })
            .on('end', () => {
                process.stdout.write('\r');
                resolve();
            })
            .on('error', reject)
            .save(outputFile);
    });

    const elapsed = Date.now() - start;

    // Verify output exists and has content
    const outputExists = await fs.pathExists(outputFile);
    assert(outputExists, 'Output file created');

    if (outputExists) {
        const outputStat = await fs.stat(outputFile);
        assert(outputStat.size > 0, `Output file size: ${(outputStat.size / 1024 / 1024).toFixed(1)}MB`);

        // Verify output is valid video
        const outputMeta = await getVideoMetadata(outputFile);
        const outputDuration = parseFloat(outputMeta.format.duration);
        const expectedTalkingDuration = talkingRanges.reduce((s, r) => s + (r.end - r.start), 0);

        assert(outputDuration > 0, `Output duration: ${outputDuration.toFixed(1)}s`);
        assert(outputDuration < inputDuration, `Output (${outputDuration.toFixed(1)}s) shorter than input (${inputDuration.toFixed(1)}s)`);
        assert(Math.abs(outputDuration - expectedTalkingDuration) < 3, `Duration matches expected (${expectedTalkingDuration.toFixed(1)}s ± 3s)`);

        // Verify both streams have matching duration (the bug we fixed)
        const outVideoStream = outputMeta.streams.find(s => s.codec_type === 'video');
        const outAudioStream = outputMeta.streams.find(s => s.codec_type === 'audio');
        assert(outVideoStream !== undefined, 'Output has video stream');
        assert(outAudioStream !== undefined, 'Output has audio stream');

        if (outVideoStream && outAudioStream) {
            const vDur = parseFloat(outVideoStream.duration);
            const aDur = parseFloat(outAudioStream.duration);
            assert(Math.abs(vDur - aDur) < 2, `Video (${vDur.toFixed(1)}s) and Audio (${aDur.toFixed(1)}s) durations match`);
        }
    }

    console.log(`  ⏱️ Processing took ${(elapsed / 1000).toFixed(1)}s`);

    // Cleanup
    await fs.remove(TEMP_DIR);

    return outputFile;
}

async function test_06_withNormalization(talkingRanges) {
    section('Test 6: Single-Pass with Audio Normalization');

    await fs.ensureDir(OUTPUT_DIR);
    await fs.ensureDir(TEMP_DIR);

    // Build filter script WITH normalization
    const filterGraph = buildFilterScript(talkingRanges, true);
    const scriptPath = path.join(TEMP_DIR, 'filter_script.txt');
    await fs.writeFile(scriptPath, filterGraph, 'utf8');

    assert(filterGraph.includes('loudnorm'), 'Filter script includes loudnorm');

    const outputFile = path.join(OUTPUT_DIR, 'test_output_normalized.mp4');
    const encoding = getEncodingOptions('fast');

    const start = Date.now();

    await new Promise((resolve, reject) => {
        const outputOptions = [
            '-filter_complex_script', scriptPath,
            '-map', '[outv]',
            '-map', '[outa]',
            '-c:v', encoding.videoCodec,
            ...encoding.videoQuality,
            '-c:a', encoding.audioCodec,
            '-b:a', encoding.audioBitrate,
            '-avoid_negative_ts', 'make_zero'
        ];
        if (encoding.extraOptions) outputOptions.push(...encoding.extraOptions);

        ffmpeg(TEST_VIDEO)
            .outputOptions(outputOptions)
            .on('progress', progress => {
                if (progress && progress.timemark) {
                    process.stdout.write(`\r  ⏳ Processing with normalization... timemark: ${progress.timemark}    `);
                }
            })
            .on('end', () => {
                process.stdout.write('\r');
                resolve();
            })
            .on('error', reject)
            .save(outputFile);
    });

    const elapsed = Date.now() - start;

    const outputExists = await fs.pathExists(outputFile);
    assert(outputExists, 'Normalized output file created');

    if (outputExists) {
        const outputMeta = await getVideoMetadata(outputFile);
        const outputDuration = parseFloat(outputMeta.format.duration);
        assert(outputDuration > 0, `Output duration: ${outputDuration.toFixed(1)}s`);

        const outAudioStream = outputMeta.streams.find(s => s.codec_type === 'audio');
        assert(outAudioStream !== undefined, 'Output has audio stream');
    }

    console.log(`  ⏱️ Normalized processing took ${(elapsed / 1000).toFixed(1)}s`);

    // Cleanup
    await fs.remove(TEMP_DIR);
}

async function test_07_tempCleanup() {
    section('Test 7: Temp File Cleanup');

    await fs.ensureDir(TEMP_DIR);

    // Create some dummy temp files
    await fs.writeFile(path.join(TEMP_DIR, 'filter_script.txt'), 'test', 'utf8');
    await fs.writeFile(path.join(TEMP_DIR, 'dummy.txt'), 'test', 'utf8');

    const existsBefore = await fs.pathExists(TEMP_DIR);
    assert(existsBefore, 'Temp dir exists before cleanup');

    await fs.remove(TEMP_DIR);

    const existsAfter = await fs.pathExists(TEMP_DIR);
    assert(!existsAfter, 'Temp dir removed after cleanup');
}

async function test_08_edgeCases() {
    section('Test 8: Edge Cases');

    // Empty silence ranges → no talking ranges should still cover full video
    const metadata = await getVideoMetadata(TEST_VIDEO);
    const duration = parseFloat(metadata.format.duration);

    const noSilence = calculateTalkingRanges([], duration);
    assert(noSilence.length === 1, `No silence → 1 talking range covering full video`);
    assert(Math.abs(noSilence[0].start) < 0.01, 'Starts at 0');
    assert(Math.abs(noSilence[0].end - duration) < 0.01, `Ends at ${duration.toFixed(1)}s`);

    // Single silence in the middle
    const singleSilence = [{ start: 10, end: 15 }];
    const ranges = calculateTalkingRanges(singleSilence, 30);
    assert(ranges.length === 2, `Single silence → 2 talking ranges`);
    assert(ranges[0].start === 0 && ranges[0].end === 10, 'First range: 0-10');
    assert(ranges[1].start === 15 && ranges[1].end === 30, 'Second range: 15-30');

    // Very short segment filtered out
    const tinyGap = [{ start: 5, end: 5.02 }]; // 20ms gap
    const tinyRanges = calculateTalkingRanges(tinyGap, 10);
    // 0-5 = 5s (kept), then 5.02-10 = 4.98 (kept)
    assert(tinyRanges.length === 2, 'Tiny silence gap still produces 2 ranges');

    // Silence at the very start
    const startSilence = [{ start: 0, end: 5 }];
    const startRanges = calculateTalkingRanges(startSilence, 20);
    assert(startRanges.length === 1, 'Silence at start → 1 talking range');
    assert(startRanges[0].start === 5, 'Talking starts after silence');

    // Silence at the very end
    const endSilence = [{ start: 15, end: 20 }];
    const endRanges = calculateTalkingRanges(endSilence, 20);
    assert(endRanges.length === 1, 'Silence at end → 1 talking range');
    assert(endRanges[0].end === 15, 'Talking ends before silence');

    // Duration stats
    const stats = calculateDurationStats([{ start: 10, end: 20 }], 60);
    assert(stats.totalSilenceDuration === 10, 'Total silence = 10s');
    assert(stats.expectedOutputDuration === 50, 'Expected output = 50s');
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================

async function runAllTests() {
    console.log('🚀 Klyppr Desktop — Test Suite');
    console.log(`📅 ${new Date().toISOString()}`);

    // Check prerequisites
    if (!await fs.pathExists(TEST_VIDEO)) {
        console.error(`❌ Test video not found: ${TEST_VIDEO}`);
        process.exit(1);
    }

    try {
        // Test 1: Metadata
        await test_01_videoMetadata();

        // Test 2: Silence detection
        const silenceRanges = await test_02_silenceDetection();

        // Test 3: Talking ranges
        const talkingRanges = await test_03_talkingRanges(silenceRanges);

        // Test 4: Filter script
        await test_04_filterScript(talkingRanges);

        // Test 5: Single-pass processing
        await test_05_singlePassProcessing(talkingRanges);

        // Test 6: With normalization
        await test_06_withNormalization(talkingRanges);

        // Test 7: Temp cleanup
        await test_07_tempCleanup();

        // Test 8: Edge cases
        await test_08_edgeCases();

    } catch (error) {
        console.error(`\n💥 Fatal error: ${error.message}`);
        console.error(error.stack);
    }

    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📋 RESULTS: ${passCount}/${testCount} passed, ${failCount} failed`);
    console.log('='.repeat(60));

    if (failCount > 0) {
        process.exit(1);
    }
}

runAllTests();
