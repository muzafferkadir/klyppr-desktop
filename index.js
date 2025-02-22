const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');
const path = require('path');

// FFmpeg binary yollarını ayarla
const ffmpegPath = path.join(__dirname, 'bin', 'ffmpeg');
const ffprobePath = path.join(__dirname, 'bin', 'ffprobe');
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);


// Sessizlik analizi için parametreler
const SILENCE_DB = '-45dB';  // -45dB altındaki sesleri sessizlik olarak kabul et
const MIN_SILENCE_DURATION = 0.6;  // Minimum sessizlik süresi (saniye)
const PADDING_DURATION = 0.05;  // Sessizlik başı ve sonu için bırakılacak padding (saniye)

async function detectSilence(inputFile) {
    console.log(`\n[Sessizlik Tespiti] Başlatılıyor: ${inputFile}`);
    console.log(`[Sessizlik Tespiti] Parametreler: Sessizlik eşiği=${SILENCE_DB}, Min süre=${MIN_SILENCE_DURATION}s, Padding=${PADDING_DURATION}s`);
    
    return new Promise((resolve, reject) => {
        let silenceRanges = [];
        let startTime = null;

        ffmpeg(inputFile)
            .outputOptions(['-f', 'null'])
            .audioFilters(`silencedetect=noise=${SILENCE_DB}:d=${MIN_SILENCE_DURATION}`)
            .output('-')
            .on('start', command => {
                console.log(`[FFmpeg Komutu] ${command}`);
            })
            .on('stderr', line => {
                const silenceStart = line.match(/silence_start: ([\d.]+)/);
                const silenceEnd = line.match(/silence_end: ([\d.]+)/);

                if (silenceStart) {
                    startTime = parseFloat(silenceStart[1]);
                    console.log(`[Sessizlik Başlangıcı] ${startTime}s`);
                }
                if (silenceEnd && startTime !== null) {
                    const endTime = parseFloat(silenceEnd[1]);
                    const duration = endTime - startTime;
                    console.log(`[Sessizlik Bitişi] ${endTime}s (Süre: ${duration.toFixed(2)}s)`);
                    
                    silenceRanges.push({
                        start: startTime + PADDING_DURATION,
                        end: endTime - PADDING_DURATION
                    });
                    startTime = null;
                }
            })
            .on('end', () => {
                console.log(`[Sessizlik Tespiti] Tamamlandı. ${silenceRanges.length} sessizlik aralığı bulundu.`);
                silenceRanges.forEach((range, index) => {
                    console.log(`  Aralık ${index + 1}: ${range.start.toFixed(2)}s - ${range.end.toFixed(2)}s`);
                });
                resolve(silenceRanges);
            })
            .on('error', (err) => {
                console.error(`[Sessizlik Tespiti Hatası] ${err.message}`);
                reject(err);
            })
            .run();
    });
}

async function processVideo(inputFile) {
    try {
        console.log(`\n[Video İşleme] Başlatılıyor: ${inputFile}`);
        
        // Input dosyasının varlığını kontrol et
        try {
            await fs.access(inputFile, fs.constants.R_OK);
            console.log(`[Video İşleme] Girdi dosyası okunabilir: ${inputFile}`);
        } catch (err) {
            throw new Error(`Girdi dosyası okunamıyor: ${err.message}`);
        }

        const outputFile = path.join(
            path.dirname(inputFile),
            `processed_${path.basename(inputFile)}`
        );

        // Eğer çıktı dosyası varsa sil
        try {
            await fs.remove(outputFile);
            console.log(`[Video İşleme] Eski çıktı dosyası temizlendi: ${outputFile}`);
        } catch (err) {
            console.log(`[Video İşleme] Eski çıktı dosyası bulunamadı: ${outputFile}`);
        }

        // Sessizlikleri tespit et
        const silenceRanges = await detectSilence(inputFile);

        if (silenceRanges.length === 0) {
            console.log('[Video İşleme] Sessizlik bulunamadı, dosya kopyalanıyor...');
            await fs.copyFile(inputFile, outputFile);
            return outputFile;
        }

        // Sessiz olmayan bölümleri birleştir
        return new Promise((resolve, reject) => {
            // Sessiz bölümleri atlayan bir select filtresi oluştur
            let selectParts = [];
            
            // İlk bölüm (başlangıçtan ilk sessizliğe kadar)
            if (silenceRanges[0].start > 0) {
                selectParts.push(`between(t,0,${silenceRanges[0].start})`);
            }

            // Sessizlikler arası bölümler
            for (let i = 0; i < silenceRanges.length - 1; i++) {
                selectParts.push(
                    `between(t,${silenceRanges[i].end},${silenceRanges[i + 1].start})`
                );
            }

            // Son bölüm (son sessizlikten sona kadar)
            const lastSilence = silenceRanges[silenceRanges.length - 1];
            selectParts.push(`gte(t,${lastSilence.end})`);

            // Select filtresini oluştur
            const selectFilter = selectParts.join('+');

            // Video ve ses filtreleri
            const command = ffmpeg(inputFile)
                .inputOptions([
                    '-y',                    // Çıktı dosyasının üzerine yaz
                    '-loglevel', 'verbose',  // Detaylı log
                    '-threads', '0'          // Tüm CPU çekirdeklerini kullan
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
                    // Video codec ve optimizasyonlar
                    '-c:v', 'libx264',          // H.264 codec
                    '-preset', 'ultrafast',      // En hızlı encoding preset
                    '-tune', 'fastdecode',      // Hızlı decode için optimize et
                    '-profile:v', 'baseline',   // En basit ve hızlı profil
                    '-level', '3.0',           // Uyumlu level
                    '-x264-params', 'ref=1:bframes=0',  // Reference frame ve B-frame optimizasyonu
                    
                    // Ses codec
                    '-c:a', 'aac',
                    '-b:a', '128k',
                    
                    // Diğer optimizasyonlar
                    '-movflags', '+faststart',
                    '-max_muxing_queue_size', '9999',
                    '-threads', '0'               // Çıktı işleme için tüm çekirdekleri kullan
                ]);

            // FFmpeg komutunu logla
            command.on('start', cmd => {
                console.log('\n[FFmpeg Tam Komut]');
                console.log(cmd);
            });

            // FFmpeg stderr çıktısını logla
            command.on('stderr', line => {
                if (line.includes('Error') || line.includes('Invalid') || line.includes('No such')) {
                    console.error(`[FFmpeg Hata] ${line}`);
                } else {
                    console.log(`[FFmpeg Log] ${line}`);
                }
            });

            // İlerleme durumunu göster
            command.on('progress', progress => {
                const percent = progress.percent ? progress.percent.toFixed(1) : '0';
                const time = progress.timemark || '00:00:00';
                console.log(`[İşlem] %${percent} tamamlandı (${time})`);
            });

            // İşlem sonucunu işle
            command.on('end', () => {
                console.log('[Video İşleme] Başarıyla tamamlandı');
                resolve(outputFile);
            });

            command.on('error', (err) => {
                console.error('\n[Video İşleme Hatası]');
                console.error('Hata mesajı:', err.message);
                console.error('Stack trace:', err.stack);
                reject(err);
            });

            // Komutu çalıştır
            command.save(outputFile);
        });
    } catch (error) {
        console.error('[Kritik Hata]', error);
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

        console.log(`${videoFiles.length} video dosyası bulundu.`);

        for (const file of videoFiles) {
            const inputPath = path.join(videosDir, file);
            console.log(`İşleniyor: ${file}`);
            try {
                const outputPath = await processVideo(inputPath);
                console.log(`İşlem tamamlandı: ${path.basename(outputPath)}`);
            } catch (err) {
                console.error(`Hata: ${file} işlenirken bir sorun oluştu:`, err);
            }
        }
    } catch (err) {
        console.error('Bir hata oluştu:', err);
    }
}

// Uygulamayı başlat
processAllVideos(); 