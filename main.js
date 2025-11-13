const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');

// Config dosyası yolu
const configPath = path.join(app.getPath('userData'), 'config.json');

// Config okuma
function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (error) {
        console.error('Config okuma hatası:', error);
    }
    return {};
}

// Config yazma
function saveConfig(config) {
    try {
        fs.ensureDirSync(path.dirname(configPath));
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch (error) {
        console.error('Config yazma hatası:', error);
    }
}

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
        const outputPath = result.filePaths[0];
        event.reply('output-selected', outputPath);
        
        // Son seçilen output path'i kaydet
        const config = loadConfig();
        config.lastOutputPath = outputPath;
        saveConfig(config);
    }
});

// Son output path'i yükle
ipcMain.on('load-last-output', (event) => {
    const config = loadConfig();
    if (config.lastOutputPath && fs.existsSync(config.lastOutputPath)) {
        event.reply('output-selected', config.lastOutputPath);
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
            event.reply('completed', { success: true, outputFile: outputFile });
            return;
        }

        // Phase 2: Process video
        event.reply('progress', {
            status: 'Phase 2: Processing video (removing silences)...',
            percent: 0
        });
        
        await processVideo(params.inputPath, outputFile, silenceRanges, params, event);
        event.reply('completed', { success: true, outputFile: outputFile });
    } catch (error) {
        event.reply('log', `Error: ${error.message}`);
        event.reply('completed', { success: false });
    }
});

// Show output file in folder
ipcMain.on('show-in-folder', (event, filePath) => {
    shell.showItemInFolder(filePath);
});

async function detectSilence(inputFile, params, event) {
    return new Promise((resolve, reject) => {
        let silenceRanges = [];
        let startTime = null;
        let hasAudioStream = false;

        event.reply('log', '🔍 Starting silence analysis...');
        event.reply('log', `Parameters: Threshold=${params.silenceDb}dB, Min Duration=${params.minSilenceDuration}s, Padding=${params.paddingDuration}s`);

        // First check if video has audio stream
        ffmpeg.ffprobe(inputFile, (probeErr, metadata) => {
            if (probeErr) {
                event.reply('log', `⚠️ Warning: Could not probe file: ${probeErr.message}`);
                return reject(probeErr);
            }

            hasAudioStream = metadata.streams.some(s => s.codec_type === 'audio');
            
            if (!hasAudioStream) {
                event.reply('log', '⚠️ No audio stream found in video - skipping silence detection');
                return resolve([]);
            }

            // Proceed with silence detection
            ffmpeg(inputFile)
                .outputOptions(['-f', 'null'])
                .audioFilters(`silencedetect=noise=${params.silenceDb}dB:d=${params.minSilenceDuration}`)
                .output('-')
                .on('start', command => {
                    event.reply('log', `Analyzing audio...`);
                })
                .on('stderr', line => {
                    const silenceStart = line.match(/silence_start: ([\d.]+)/);
                    const silenceEnd = line.match(/silence_end: ([\d.]+)/);

                    if (silenceStart) {
                        startTime = parseFloat(silenceStart[1]);
                        event.reply('log', `  🔇 Silence detected at ${startTime.toFixed(2)}s`);
                    }
                    if (silenceEnd && startTime !== null) {
                        const endTime = parseFloat(silenceEnd[1]);
                        const paddingDur = parseFloat(params.paddingDuration);
                        const adjustedStart = startTime + paddingDur;
                        const adjustedEnd = endTime - paddingDur;
                        const duration = adjustedEnd - adjustedStart;
                        
                        // Only add if duration is positive and meaningful
                        if (duration > 0.05) {  // Minimum 50ms for audio frame safety
                            silenceRanges.push({
                                start: adjustedStart,
                                end: adjustedEnd
                            });
                            event.reply('log', `  ✓ Silence: ${adjustedStart.toFixed(3)}s - ${adjustedEnd.toFixed(3)}s (${duration.toFixed(2)}s)`);
                        } else {
                            event.reply('log', `  ⚠️ Skipped (too short): ${duration.toFixed(3)}s`);
                        }
                        startTime = null;
                    }
                })
                .on('end', () => {
                    event.reply('log', `\n✅ Analysis complete: Found ${silenceRanges.length} silence ranges`);
                    if (silenceRanges.length > 0) {
                        const totalSilence = silenceRanges.reduce((sum, r) => sum + (r.end - r.start), 0);
                        event.reply('log', `Total silence duration: ${totalSilence.toFixed(2)}s`);
                    }
                    resolve(silenceRanges);
                })
                .on('error', (err) => {
                    event.reply('log', `❌ Error during silence detection: ${err.message}`);
                    reject(err);
                })
                .run();
        });
    });
}

// Calculate non-silent segments from silence ranges
function calculateNonSilentSegments(silenceRanges, totalDuration, event) {
    const segments = [];
    const MIN_SEGMENT_DURATION = 0.05; // 50ms minimum
    
    // Add first segment if video doesn't start with silence
    if (silenceRanges.length === 0) {
        // No silence detected, return entire video
        event.reply('log', '  → No silences, keeping entire video');
        return [{ start: 0, end: totalDuration }];
    }
    
    event.reply('log', `\n📐 Calculating non-silent segments from ${silenceRanges.length} silence ranges:`);
    
    // First segment (start to first silence)
    if (silenceRanges[0].start > MIN_SEGMENT_DURATION) {
        segments.push({
            start: 0,
            end: silenceRanges[0].start
        });
        event.reply('log', `  ✓ Segment 1: 0.000s → ${silenceRanges[0].start.toFixed(3)}s (${silenceRanges[0].start.toFixed(2)}s)`);
    } else {
        event.reply('log', `  ⊗ Skipped start segment (too short: ${silenceRanges[0].start.toFixed(3)}s)`);
    }
    
    // Middle segments (between silences)
    for (let i = 0; i < silenceRanges.length - 1; i++) {
        const segStart = silenceRanges[i].end;
        const segEnd = silenceRanges[i + 1].start;
        const duration = segEnd - segStart;
        
        // Only add if segment is meaningful
        if (duration > MIN_SEGMENT_DURATION) {
            segments.push({
                start: segStart,
                end: segEnd
            });
            event.reply('log', `  ✓ Segment ${segments.length}: ${segStart.toFixed(3)}s → ${segEnd.toFixed(3)}s (${duration.toFixed(2)}s)`);
        } else {
            event.reply('log', `  ⊗ Skipped middle segment ${i + 1} (too short: ${duration.toFixed(3)}s)`);
        }
    }
    
    // Last segment (last silence to end)
    const lastSilence = silenceRanges[silenceRanges.length - 1];
    const lastSegmentDuration = totalDuration - lastSilence.end;
    
    if (lastSegmentDuration > MIN_SEGMENT_DURATION) {
        segments.push({
            start: lastSilence.end,
            end: totalDuration
        });
        event.reply('log', `  ✓ Segment ${segments.length} (final): ${lastSilence.end.toFixed(3)}s → ${totalDuration.toFixed(3)}s (${lastSegmentDuration.toFixed(2)}s)`);
    } else {
        event.reply('log', `  ⊗ Skipped final segment (too short: ${lastSegmentDuration.toFixed(3)}s)`);
    }
    
    event.reply('log', `\n✅ Total segments to extract: ${segments.length}`);
    
    return segments;
}

// Extract segments and concatenate them
async function processVideo(inputFile, outputFile, silenceRanges, params, event) {
    return new Promise(async (resolve, reject) => {
        try {
            // Get video metadata for duration and stream info
            ffmpeg.ffprobe(inputFile, async (err, metadata) => {
                if (err) {
                    event.reply('log', `❌ Error reading video metadata: ${err.message}`);
                    return reject(err);
                }
                
                const totalDuration = metadata.format.duration;
                const videoStream = metadata.streams.find(s => s.codec_type === 'video');
                const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
                
                if (!videoStream) {
                    return reject(new Error('No video stream found'));
                }
                
                event.reply('log', `📊 Input Duration: ${totalDuration.toFixed(2)}s`);
                event.reply('log', `📹 Video: ${videoStream.codec_name} ${videoStream.width}x${videoStream.height} @ ${videoStream.r_frame_rate} fps`);
                if (audioStream) {
                    event.reply('log', `🔊 Audio: ${audioStream.codec_name} ${audioStream.sample_rate}Hz ${audioStream.channels}ch`);
                }
                
                // Audio normalization info
                if (params.normalizeAudio) {
                    event.reply('log', `🎚️  Audio Normalization: Enabled (Target: -16 LUFS)`);
                } else {
                    event.reply('log', `🎚️  Audio Normalization: Disabled`);
                }
                
                // Calculate non-silent segments
                const segments = calculateNonSilentSegments(silenceRanges, totalDuration, event);
                
                if (segments.length === 0) {
                    event.reply('log', '⚠️ No non-silent segments found!');
                    return reject(new Error('No content to process'));
                }
                
                const expectedOutputDuration = segments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
                const reductionPercent = ((totalDuration - expectedOutputDuration) / totalDuration * 100).toFixed(1);
                event.reply('log', `📊 Expected output: ${expectedOutputDuration.toFixed(2)}s (${reductionPercent}% reduction)`);
                
                // Create temp directory for segments
                const tempDir = path.join(path.dirname(outputFile), '.klyppr_temp');
                await fs.ensureDir(tempDir);
                
                try {
                    // Extract each segment (parallel batch processing)
                    event.reply('log', `\n🎬 Phase 2.1: Extracting ${segments.length} segments...`);
                    const segmentFiles = [];
                    
                    // Prepare segment file paths
                    for (let i = 0; i < segments.length; i++) {
                        const segmentFile = path.join(tempDir, `segment_${i.toString().padStart(4, '0')}.mp4`);
                        segmentFiles.push(segmentFile);
                    }
                    
                    // Process segments in parallel batches
                    const BATCH_SIZE = 4; // Process 4 segments simultaneously
                    let processedCount = 0;
                    
                    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
                        const batchEnd = Math.min(i + BATCH_SIZE, segments.length);
                        const batchSegments = segments.slice(i, batchEnd);
                        const batchFiles = segmentFiles.slice(i, batchEnd);
                        
                        event.reply('log', `\n  Batch ${Math.floor(i / BATCH_SIZE) + 1}: Processing segments ${i + 1}-${batchEnd}...`);
                        
                        // Process batch in parallel
                        await Promise.all(
                            batchSegments.map((seg, idx) => 
                                extractSegment(inputFile, batchFiles[idx], seg.start, seg.end, params, event)
                            )
                        );
                        
                        processedCount += batchSegments.length;
                        const segmentProgress = ((processedCount / segments.length) * 50).toFixed(1);
                        event.reply('progress', {
                            status: `Extracted ${processedCount}/${segments.length} segments...`,
                            percent: parseFloat(segmentProgress)
                        });
                        event.reply('log', `  ✓ Batch ${Math.floor(i / BATCH_SIZE) + 1} complete (${processedCount}/${segments.length} segments)`);
                    }
                    
                    event.reply('log', `\n✅ All ${segments.length} segments extracted successfully`)
                    
                    // Concatenate segments
                    event.reply('log', `\n🔗 Phase 2.2: Concatenating ${segments.length} segments...`);
                    event.reply('progress', {
                        status: 'Merging segments...',
                        percent: 50
                    });
                    
                    await concatenateSegments(segmentFiles, outputFile, params, event);
                    
                    // Cleanup temp files
                    event.reply('log', '\n🧹 Cleaning up temporary files...');
                    await fs.remove(tempDir);
                    
                    event.reply('log', '✅ Video processing completed successfully!');
                    event.reply('progress', {
                        status: 'Complete!',
                        percent: 100
                    });
                    
                    resolve();
                } catch (error) {
                    // Cleanup on error
                    await fs.remove(tempDir).catch(() => {});
                    throw error;
                }
            });
        } catch (error) {
            event.reply('log', `❌ Error: ${error.message}`);
            reject(error);
        }
    });
}

// Extract a single segment with exact timing
function extractSegment(inputFile, outputFile, startTime, endTime, params, event) {
    return new Promise((resolve, reject) => {
        const duration = endTime - startTime;
        
        // Use accurate seeking: -ss after -i for precise cuts
        const command = ffmpeg(inputFile);
        
        // Audio filter - apply loudness normalization if enabled
        if (params.normalizeAudio) {
            command.audioFilters([
                'loudnorm=I=-16:TP=-1.5:LRA=11' // YouTube standard: -16 LUFS, True Peak -1.5dB
            ]);
        }
        
        command
            .outputOptions([
                '-ss', startTime.toString(),      // Accurate seek (after input)
                '-t', duration.toString(),        // Duration to extract
                // High quality encoding
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', '20',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-ar', '48000',
                '-ac', '2',
                // Timestamp handling for proper sync
                '-avoid_negative_ts', 'make_zero',
                '-max_muxing_queue_size', '9999'
            ])
            .on('start', (cmd) => {
                event.reply('log', `    ⏱️  ${startTime.toFixed(2)}s → ${endTime.toFixed(2)}s (${duration.toFixed(2)}s)`);
            })
            .on('error', (err) => {
                event.reply('log', `    ❌ Error: ${err.message}`);
                reject(err);
            })
            .on('end', () => {
                resolve();
            })
            .save(outputFile);
    });
}

// Concatenate segments using concat demuxer (best method for preserving sync)
function concatenateSegments(segmentFiles, outputFile, params, event) {
    return new Promise(async (resolve, reject) => {
        try {
            // Verify all segment files exist
            event.reply('log', '🔍 Verifying segment files...');
            for (let i = 0; i < segmentFiles.length; i++) {
                const exists = await fs.pathExists(segmentFiles[i]);
                if (!exists) {
                    throw new Error(`Segment file not found: ${segmentFiles[i]}`);
                }
                const stats = await fs.stat(segmentFiles[i]);
                event.reply('log', `  ✓ Segment ${i + 1}: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
            }
            
            // Create concat list file with proper Windows path handling
            const concatListFile = path.join(path.dirname(outputFile), '.concat_list.txt');
            
            // Convert paths to absolute and escape properly for concat demuxer
            const concatContent = segmentFiles.map(f => {
                const absolutePath = path.resolve(f);
                // For concat demuxer, use forward slashes and escape single quotes
                const normalizedPath = absolutePath.replace(/\\/g, '/').replace(/'/g, "\\'");
                return `file '${normalizedPath}'`;
            }).join('\n');
            
            await fs.writeFile(concatListFile, concatContent, 'utf8');
            event.reply('log', `📝 Concat list created with ${segmentFiles.length} segments`);
            
            // Use concat demuxer to merge segments
            const command = ffmpeg()
                .input(concatListFile)
                .inputOptions([
                    '-f', 'concat',
                    '-safe', '0'
                ]);
            
            // Audio filter - apply loudness normalization if enabled
            if (params.normalizeAudio) {
                command.audioFilters([
                    'loudnorm=I=-16:TP=-1.5:LRA=11' // YouTube standard: -16 LUFS
                ]);
                event.reply('log', '🎚️  Applying audio normalization to final output...');
            }
            
            command
                .outputOptions([
                    // Re-encode with high quality to ensure compatibility
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-crf', '18',
                    '-c:a', 'aac',
                    '-b:a', '192k',
                    '-ar', '48000',
                    '-ac', '2',
                    // Ensure proper sync
                    '-vsync', 'cfr',
                    '-async', '1',
                    '-max_muxing_queue_size', '9999',
                    '-movflags', '+faststart'
                ])
                .on('start', (cmd) => {
                    event.reply('log', '🔗 Merging segments...');
                })
                .on('progress', (progress) => {
                    if (progress.percent) {
                        const totalPercent = 50 + (progress.percent / 2);
                        event.reply('progress', {
                            status: `Merging: ${progress.percent.toFixed(1)}%`,
                            percent: totalPercent
                        });
                    }
                })
                .on('error', async (err) => {
                    await fs.remove(concatListFile).catch(() => {});
                    event.reply('log', `❌ Error concatenating: ${err.message}`);
                    reject(err);
                })
                .on('end', async () => {
                    await fs.remove(concatListFile).catch(() => {});
                    event.reply('log', '✓ Segments merged successfully');
                    resolve();
                })
                .save(outputFile);
        } catch (error) {
            event.reply('log', `❌ Concatenation error: ${error.message}`);
            reject(error);
        }
    });
} 