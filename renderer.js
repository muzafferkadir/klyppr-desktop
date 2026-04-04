// ============================================================================
// PRESETS
// ============================================================================

const presets = {
    recommended: {
        silenceDb: -35,
        minSilenceDuration: 0.5,
        paddingDuration: 0.05
    },
    fast: {
        silenceDb: -30,
        minSilenceDuration: 0.4,
        paddingDuration: 0.035
    }
};

// ============================================================================
// DOM REFERENCES
// ============================================================================

let currentOutputFile = null;

function $(id) { return document.getElementById(id); }

// ============================================================================
// FILE SELECTION
// ============================================================================

function selectInput() {
    window.klyppr.selectInput();
}

function selectOutput() {
    window.klyppr.selectOutput();
}

function updateStartButton() {
    const inputPath = $('inputPath').value;
    const outputPath = $('outputPath').value;
    const startBtn = $('startBtn');
    startBtn.disabled = !(inputPath && outputPath);
    startBtn.setAttribute('data-tooltip',
        inputPath && outputPath ? 'Start processing video' : 'Select input and output first'
    );
}

// ============================================================================
// PROCESSING
// ============================================================================

function startProcessing() {
    const params = {
        inputPath: $('inputPath').value,
        outputPath: $('outputPath').value,
        silenceDb: $('silenceDb').value,
        minSilenceDuration: $('minSilenceDuration').value,
        paddingDuration: $('paddingDuration').value,
        normalizeAudio: $('normalizeAudio').checked,
        qualityPreset: $('qualityPreset').value,
        useHardwareEncoder: $('useHardwareEncoder').checked
    };

    // Save settings for next session
    window.klyppr.saveSettings({
        silenceDb: params.silenceDb,
        minSilenceDuration: params.minSilenceDuration,
        paddingDuration: params.paddingDuration,
        qualityPreset: params.qualityPreset,
        normalizeAudio: params.normalizeAudio,
        useHardwareEncoder: params.useHardwareEncoder
    });

    $('startBtn').disabled = true;
    $('progress').style.display = 'block';
    $('logSection').style.display = 'block';
    $('status').textContent = 'Starting process...';
    $('progressBar').style.width = '0%';

    // Clear log and collapse
    $('log').replaceChildren();
    $('logContainer').style.display = 'none';
    $('logToggleBtn').querySelector('.log-toggle-icon').textContent = '\u25BC';
    $('logToggleBtn').querySelector('.log-toggle-text').textContent = 'Show Processing Logs';

    window.klyppr.startProcessing(params);
}

// ============================================================================
// LOGS
// ============================================================================

function toggleLogs() {
    const logContainer = $('logContainer');
    const toggleBtn = $('logToggleBtn');
    const toggleIcon = toggleBtn.querySelector('.log-toggle-icon');

    if (logContainer.style.display === 'none') {
        logContainer.style.display = 'block';
        toggleIcon.textContent = '\u25B2';
        toggleBtn.querySelector('.log-toggle-text').textContent = 'Hide Processing Logs';
    } else {
        logContainer.style.display = 'none';
        toggleIcon.textContent = '\u25BC';
        toggleBtn.querySelector('.log-toggle-text').textContent = 'Show Processing Logs';
    }
}

function copyLogs() {
    const logElement = $('log');
    const logText = logElement.innerText || logElement.textContent;
    if (!logText.trim()) return;

    navigator.clipboard.writeText(logText).then(() => {
        const copyBtn = $('logCopyBtn');
        const copyText = copyBtn.querySelector('.log-copy-text');
        const originalText = copyText.textContent;

        copyText.textContent = 'Copied!';
        copyBtn.classList.add('copied');

        setTimeout(() => {
            copyText.textContent = originalText;
            copyBtn.classList.remove('copied');
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy logs:', err);
    });
}

// ============================================================================
// MODAL
// ============================================================================

function showCompletionModal() {
    $('completionModal').style.display = 'flex';
}

function closeModal() {
    $('completionModal').style.display = 'none';
}

function openFolderFromModal() {
    if (currentOutputFile) {
        window.klyppr.showInFolder(currentOutputFile);
    }
    closeModal();
}

// ============================================================================
// DRAG & DROP
// ============================================================================

function setupDragAndDrop() {
    const dropZone = $('inputDropZone');
    const videoExts = window.klyppr.videoExtensions;

    // Prevent Electron from navigating to dropped files
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');

        const file = e.dataTransfer.files[0];
        if (!file) return;

        const ext = file.name.split('.').pop().toLowerCase();
        if (videoExts.includes(ext)) {
            $('inputPath').value = file.path;
            updateStartButton();
        }
    });
}

// ============================================================================
// IPC LISTENERS
// ============================================================================

function setupIPC() {
    window.klyppr.onInputSelected((path) => {
        $('inputPath').value = path;
        updateStartButton();
    });

    window.klyppr.onOutputSelected((path) => {
        $('outputPath').value = path;
        updateStartButton();
    });

    window.klyppr.onProgress((data) => {
        $('status').textContent = data.status;
        $('progressBar').style.width = `${data.percent}%`;
    });

    window.klyppr.onLog((message) => {
        const log = $('log');
        const line = document.createElement('div');
        line.textContent = message;
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;
    });

    window.klyppr.onCompleted((result) => {
        $('startBtn').disabled = false;
        $('status').textContent = result.success ? 'Process completed!' : 'Error occurred!';

        if (result.success) {
            currentOutputFile = result.outputFile;
            $('progressBar').style.width = '100%';
            showCompletionModal();

            setTimeout(() => {
                $('progress').style.display = 'none';
                $('progressBar').style.width = '0%';
            }, 1000);
        }
    });

    window.klyppr.onEncoderInfo((info) => {
        const label = $('gpuEncoderLabel');
        const title = $('gpuEncoderTitle');
        const desc = $('gpuEncoderDesc');
        const checkbox = $('useHardwareEncoder');

        if (info && info.available) {
            label.style.display = '';
            title.textContent = `GPU Acceleration (${info.name})`;
            desc.textContent = info.description;
            // Only default to true if user hasn't restored a saved preference
            if (!checkbox.dataset.restored) {
                checkbox.checked = true;
            }
        } else {
            label.style.display = 'none';
            checkbox.checked = false;
        }
    });
}

// ============================================================================
// EVENT BINDINGS (replacing inline onclick)
// ============================================================================

function setupEventBindings() {
    // Browse buttons
    document.querySelector('.file-selection .form-group:nth-child(1) .browse-btn')
        .addEventListener('click', selectInput);
    document.querySelector('.file-selection .form-group:nth-child(2) .browse-btn')
        .addEventListener('click', selectOutput);

    // Start button
    $('startBtn').addEventListener('click', startProcessing);

    // Preset buttons
    document.querySelectorAll('.preset-btn').forEach(button => {
        button.addEventListener('click', () => {
            document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            const preset = button.dataset.preset;
            const values = presets[preset];
            $('silenceDb').value = values.silenceDb;
            $('minSilenceDuration').value = values.minSilenceDuration;
            $('paddingDuration').value = values.paddingDuration;
        });
    });

    // Log controls
    $('logToggleBtn').addEventListener('click', toggleLogs);
    $('logCopyBtn').addEventListener('click', copyLogs);

    // Modal
    document.querySelector('.modal-backdrop').addEventListener('click', closeModal);
    document.querySelector('.modal-close').addEventListener('click', closeModal);
    document.querySelector('.modal-btn-primary').addEventListener('click', openFolderFromModal);
    document.querySelector('.modal-btn-secondary').addEventListener('click', closeModal);
}

// ============================================================================
// SETTINGS RESTORE
// ============================================================================

async function restoreSettings() {
    const saved = await window.klyppr.loadSettings();
    if (!saved) return;

    if (saved.silenceDb != null)          $('silenceDb').value = saved.silenceDb;
    if (saved.minSilenceDuration != null) $('minSilenceDuration').value = saved.minSilenceDuration;
    if (saved.paddingDuration != null)    $('paddingDuration').value = saved.paddingDuration;
    if (saved.qualityPreset != null)      $('qualityPreset').value = saved.qualityPreset;
    if (saved.normalizeAudio != null)     $('normalizeAudio').checked = saved.normalizeAudio;
    if (saved.useHardwareEncoder != null) {
        $('useHardwareEncoder').checked = saved.useHardwareEncoder;
        $('useHardwareEncoder').dataset.restored = 'true';
    }

    // Saved values may not match any preset — clear active state
    document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));
}

// ============================================================================
// INIT
// ============================================================================

window.addEventListener('DOMContentLoaded', async () => {
    setupEventBindings();
    setupIPC();
    setupDragAndDrop();

    await restoreSettings();

    window.klyppr.loadLastOutput();
    window.klyppr.getEncoderInfo();
});
