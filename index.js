const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');
const path = require('path');

// Set FFmpeg binary paths
const ffmpegPath = path.join(__dirname, 'bin', 'ffmpeg');
const ffprobePath = path.join(__dirname, 'bin', 'ffprobe');
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Parameters for silence analysis
const SILENCE_DB = '-45dB';  // Consider sounds below -45dB as silence
const MIN_SILENCE_DURATION = 0.6;  // Minimum silence duration (seconds)
const PADDING_DURATION = 0.05;  // Padding duration at the start and end of silence (seconds)

async function detectSilence(inputFile) {
    console.log(`\n[Silence Detection] Starting: ${inputFile}`);
    console.log(`[Silence Detection] Parameters: Silence threshold=${SILENCE_DB}, Min duration=${MIN_SILENCE_DURATION}s, Padding=${PADDING_DURATION}s`);
    
    return new Promise((resolve, reject) => {
        let silenceRanges = [];
        let startTime = null;

        ffmpeg(inputFile)
            .outputOptions(['-f', 'null'])
            .audioFilters(`silencedetect=noise=${SILENCE_DB}:d=${MIN_SILENCE_DURATION}`)
            .output('-')
            .on('start', command => {
                console.log(`[FFmpeg Command] ${command}`);
            })
            .on('stderr', line => {
                const silenceStart = line.match(/silence_start: ([\d.]+)/);
                const silenceEnd = line.match(/silence_end: ([\d.]+)/);

                if (silenceStart) {
                    startTime = parseFloat(silenceStart[1]);
                    console.log(`[Silence Start] ${startTime}s`);
                }
                if (silenceEnd && startTime !== null) {
                    const endTime = parseFloat(silenceEnd[1]);
                    const duration = endTime - startTime;
                    console.log(`[Silence End] ${endTime}s (Duration: ${duration.toFixed(2)}s)`);
                    
                    silenceRanges.push({
                        start: startTime + PADDING_DURATION,
                        end: endTime - PADDING_DURATION
                    });
                    startTime = null;
                }
            })
            .on('end', () => {
                console.log(`[Silence Detection] Completed. Found ${silenceRanges.length} silence ranges.`);
                silenceRanges.forEach((range, index) => {
                    console.log(`  Range ${index + 1}: ${range.start.toFixed(2)}s - ${range.end.toFixed(2)}s`);
                });
                resolve(silenceRanges);
            })
            .on('error', (err) => {
                console.error(`[Silence Detection Error] ${err.message}`);
                reject(err);
            })
            .run();
    });
}

async function processVideo(inputFile) {
    try {
        console.log(`\n[Video Processing] Starting: ${inputFile}`);
        
        // Check input file accessibility
        try {
            await fs.access(inputFile, fs.constants.R_OK);
            console.log(`[Video Processing] Input file is readable: ${inputFile}`);
        } catch (err) {
            throw new Error(`Input file is not readable: ${err.message}`);
        }

        const outputFile = path.join(
            path.dirname(inputFile),
            `processed_${path.basename(inputFile)}`
        );

        // Delete output file if exists
        try {
            await fs.remove(outputFile);
            console.log(`[Video Processing] Old output file cleaned: ${outputFile}`);
        } catch (err) {
            console.log(`[Video Processing] Old output file not found: ${outputFile}`);
        }

        // Detect silences
        const silenceRanges = await detectSilence(inputFile);

        if (silenceRanges.length === 0) {
            console.log('[Video Processing] No silence found, copying file...');
            await fs.copyFile(inputFile, outputFile);
            return outputFile;
        }

        // Combine non-silent parts
        return new Promise((resolve, reject) => {
            // Create a select filter that skips silent parts
            let selectParts = [];
            
            // First part (from start to first silence)
            if (silenceRanges[0].start > 0) {
                selectParts.push(`between(t,0,${silenceRanges[0].start})`);
            }

            // Parts between silences
            for (let i = 0; i < silenceRanges.length - 1; i++) {
                selectParts.push(
                    `between(t,${silenceRanges[i].end},${silenceRanges[i + 1].start})`
                );
            }

            // Last part (from last silence to end)
            const lastSilence = silenceRanges[silenceRanges.length - 1];
            selectParts.push(`gte(t,${lastSilence.end})`);

            // Create select filter
            const selectFilter = selectParts.join('+');

            // Video and audio filters
            const command = ffmpeg(inputFile)
                .inputOptions([
                    '-y',                    // Overwrite output file
                    '-loglevel', 'verbose',  // Detailed logging
                    '-threads', '0'          // Use all CPU cores
                ])
                .videoFilters([
                    `select='${selectFilter}'`,
                    'setpts=N/FRAME_RATE/TB'
                ])
                .audioFilters([
                    `aselect='${selectFilter}'`,
                    'asetpts=N/SR/TB'
                ])
                .outputOptions([
                    // Video codec and optimizations
                    '-c:v', 'libx264',          // H.264 codec
                    '-preset', 'ultrafast',     // Fastest encoding preset
                    '-tune', 'fastdecode',      // Optimize for fast decoding
                    '-profile:v', 'baseline',   // Simplest and fastest profile
                    '-level', '3.0',           // Compatible level
                    '-x264-params', 'ref=1:bframes=0',  // Reference frame and B-frame optimization
                    
                    // Audio codec
                    '-c:a', 'aac',
                    '-b:a', '128k',
                    
                    // Other optimizations
                    '-movflags', '+faststart',
                    '-max_muxing_queue_size', '9999',
                    '-threads', '0'               // Use all cores for output processing
                ]);

            // Log FFmpeg command
            command.on('start', cmd => {
                console.log('\n[FFmpeg Full Command]');
                console.log(cmd);
            });

            // Log FFmpeg stderr output
            command.on('stderr', line => {
                if (line.includes('Error') || line.includes('Invalid') || line.includes('No such')) {
                    console.error(`[FFmpeg Error] ${line}`);
                } else {
                    console.log(`[FFmpeg Log] ${line}`);
                }
            });

            // Show progress
            command.on('progress', progress => {
                const percent = progress.percent ? progress.percent.toFixed(1) : '0';
                const time = progress.timemark || '00:00:00';
                console.log(`[Progress] ${percent}% completed (${time})`);
            });

            // Handle process result
            command.on('end', () => {
                console.log('[Video Processing] Successfully completed');
                resolve(outputFile);
            });

            command.on('error', (err) => {
                console.error('\n[Video Processing Error]');
                console.error('Error message:', err.message);
                console.error('Stack trace:', err.stack);
                reject(err);
            });

            // Run command
            command.save(outputFile);
        });
    } catch (error) {
        console.error('[Critical Error]', error);
        throw error;
    }
}

async function processAllVideos() {
    try {
        const videosDir = path.join(__dirname, 'videos');
        await fs.ensureDir(videosDir);

        const files = await fs.readdir(videosDir);
        const videoFiles = files.filter(file => 
            ['.mp4', '.avi', '.mov', '.mkv'].includes(path.extname(file).toLowerCase())
        );

        console.log(`Found ${videoFiles.length} video files.`);

        for (const file of videoFiles) {
            const inputPath = path.join(videosDir, file);
            console.log(`Processing: ${file}`);
            try {
                const outputPath = await processVideo(inputPath);
                console.log(`Processing completed: ${path.basename(outputPath)}`);
            } catch (err) {
                console.error(`Error: Problem processing ${file}:`, err);
            }
        }
    } catch (err) {
        console.error('An error occurred:', err);
    }
}

// Start the application
processAllVideos(); 