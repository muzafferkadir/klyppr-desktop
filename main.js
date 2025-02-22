const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');

// FFmpeg binary yollarını ayarla
const isDev = process.env.NODE_ENV === 'development';
const ffmpegPath = isDev 
    ? path.join(__dirname, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    : path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const ffprobePath = isDev
    ? path.join(__dirname, 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    : path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');

console.log('FFmpeg Path:', ffmpegPath);
console.log('FFprobe Path:', ffprobePath);

// FFmpeg binary'lerinin varlığını kontrol et ve izinleri ayarla
async function setupFFmpegBinaries() {
    try {
        // Dizinlerin varlığını kontrol et ve oluştur
        const binDir = isDev ? path.join(__dirname, 'bin') : path.join(process.resourcesPath, 'bin');
        await fs.ensureDir(binDir);

        // FFmpeg binary'lerinin varlığını kontrol et
        const [ffmpegExists, ffprobeExists] = await Promise.all([
            fs.pathExists(ffmpegPath),
            fs.pathExists(ffprobePath)
        ]);

        if (!ffmpegExists || !ffprobeExists) {
            throw new Error('FFmpeg veya FFprobe binary\'leri bulunamadı. Lütfen binary\'leri bin klasörüne kopyalayın.');
        }

        // İzinleri ayarla (sadece macOS ve Linux için)
        if (process.platform !== 'win32') {
            await Promise.all([
                fs.chmod(ffmpegPath, '755'),
                fs.chmod(ffprobePath, '755')
            ]);
            console.log('FFmpeg binary izinleri ayarlandı');
        }

        // FFmpeg yollarını ayarla
        ffmpeg.setFfmpegPath(ffmpegPath);
        ffmpeg.setFfprobePath(ffprobePath);
        
        console.log('FFmpeg kurulumu başarıyla tamamlandı');
    } catch (error) {
        console.error('FFmpeg kurulum hatası:', error);
        throw error;
    }
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

// Uygulama başlatıldığında
app.whenReady().then(async () => {
    try {
        await setupFFmpegBinaries();
        createWindow();
    } catch (error) {
        console.error('Uygulama başlatma hatası:', error);
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

// Input dosyası seçimi
ipcMain.on('select-input', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [
            { name: 'Video Dosyaları', extensions: ['mp4', 'avi', 'mov', 'mkv'] }
        ]
    });

    if (!result.canceled && result.filePaths.length > 0) {
        event.reply('input-selected', result.filePaths[0]);
    }
});

// Output klasörü seçimi
ipcMain.on('select-output', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });

    if (!result.canceled && result.filePaths.length > 0) {
        event.reply('output-selected', result.filePaths[0]);
    }
});

// Video işleme
ipcMain.on('start-processing', async (event, params) => {
    try {
        const outputFile = path.join(
            params.outputPath,
            `processed_${path.basename(params.inputPath)}`
        );

        // Sessizlikleri tespit et
        const silenceRanges = await detectSilence(params.inputPath, params, event);

        if (silenceRanges.length === 0) {
            event.reply('log', 'Sessizlik bulunamadı, dosya kopyalanıyor...');
            await fs.copyFile(params.inputPath, outputFile);
            event.reply('completed', true);
            return;
        }

        // Video işleme
        await processVideo(params.inputPath, outputFile, silenceRanges, event);
        event.reply('completed', true);
    } catch (error) {
        event.reply('log', `Hata: ${error.message}`);
        event.reply('completed', false);
    }
});

async function detectSilence(inputFile, params, event) {
    return new Promise((resolve, reject) => {
        let silenceRanges = [];
        let startTime = null;

        event.reply('log', 'Sessizlik analizi başlatılıyor...');

        ffmpeg(inputFile)
            .outputOptions(['-f', 'null'])
            .audioFilters(`silencedetect=noise=${params.silenceDb}dB:d=${params.minSilenceDuration}`)
            .output('-')
            .on('start', command => {
                event.reply('log', `FFmpeg komutu çalıştırılıyor: ${command}`);
            })
            .on('stderr', line => {
                const silenceStart = line.match(/silence_start: ([\d.]+)/);
                const silenceEnd = line.match(/silence_end: ([\d.]+)/);

                if (silenceStart) {
                    startTime = parseFloat(silenceStart[1]);
                    event.reply('log', `Sessizlik başlangıcı: ${startTime}s`);
                }
                if (silenceEnd && startTime !== null) {
                    const endTime = parseFloat(silenceEnd[1]);
                    event.reply('log', `Sessizlik bitişi: ${endTime}s`);
                    
                    silenceRanges.push({
                        start: startTime + parseFloat(params.paddingDuration),
                        end: endTime - parseFloat(params.paddingDuration)
                    });
                    startTime = null;
                }
            })
            .on('end', () => {
                event.reply('log', `${silenceRanges.length} sessizlik aralığı bulundu`);
                resolve(silenceRanges);
            })
            .on('error', reject)
            .run();
    });
}

async function processVideo(inputFile, outputFile, silenceRanges, event) {
    return new Promise((resolve, reject) => {
        // Sessiz bölümleri atlayan bir select filtresi oluştur
        let selectParts = [];
        
        // İlk bölüm
        if (silenceRanges[0].start > 0) {
            selectParts.push(`between(t,0,${silenceRanges[0].start})`);
        }

        // Sessizlikler arası bölümler
        for (let i = 0; i < silenceRanges.length - 1; i++) {
            selectParts.push(
                `between(t,${silenceRanges[i].end},${silenceRanges[i + 1].start})`
            );
        }

        // Son bölüm
        const lastSilence = silenceRanges[silenceRanges.length - 1];
        selectParts.push(`gte(t,${lastSilence.end})`);

        const selectFilter = selectParts.join('+');
        event.reply('log', 'Video işleme başlatılıyor...');

        ffmpeg(inputFile)
            .videoFilters([
                `select='${selectFilter}'`,
                'setpts=N/FRAME_RATE/TB'
            ])
            .audioFilters([
                `aselect='${selectFilter}'`,
                'asetpts=N/SR/TB'
            ])
            .outputOptions([
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '23',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-movflags', '+faststart'
            ])
            .on('start', command => {
                event.reply('log', `FFmpeg komutu çalıştırılıyor: ${command}`);
            })
            .on('progress', progress => {
                const percent = progress.percent ? progress.percent.toFixed(1) : '0';
                event.reply('progress', {
                    status: `İşleniyor: ${percent}%`,
                    percent: parseFloat(percent)
                });
            })
            .on('end', () => {
                event.reply('log', 'Video işleme tamamlandı');
                resolve();
            })
            .on('error', (err) => {
                event.reply('log', `Hata: ${err.message}`);
                reject(err);
            })
            .save(outputFile);
    });
} 