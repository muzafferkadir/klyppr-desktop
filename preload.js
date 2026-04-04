const { contextBridge, ipcRenderer } = require('electron');

const VIDEO_EXTENSIONS = Object.freeze([
    'mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'ts',
    'm4v', 'wmv', '3gp', 'mpg', 'mpeg', 'mts', 'vob'
]);

contextBridge.exposeInMainWorld('klyppr', {
    // Renderer -> Main (fire-and-forget)
    selectInput:      ()       => ipcRenderer.send('select-input'),
    selectOutput:     ()       => ipcRenderer.send('select-output'),
    loadLastOutput:   ()       => ipcRenderer.send('load-last-output'),
    cancelProcessing: ()       => ipcRenderer.send('cancel-processing'),
    getEncoderInfo:   ()       => ipcRenderer.send('get-encoder-info'),
    startProcessing:  (params) => ipcRenderer.send('start-processing', params),
    showInFolder:     (path)   => ipcRenderer.send('show-in-folder', path),
    saveSettings:     (s)      => ipcRenderer.send('save-settings', s),

    // Renderer -> Main (request/response)
    loadSettings: () => ipcRenderer.invoke('load-settings'),

    // Main -> Renderer (event listeners)
    onInputSelected:  (cb) => ipcRenderer.on('input-selected',  (_e, v) => cb(v)),
    onOutputSelected: (cb) => ipcRenderer.on('output-selected', (_e, v) => cb(v)),
    onProgress:       (cb) => ipcRenderer.on('progress',        (_e, v) => cb(v)),
    onLog:            (cb) => ipcRenderer.on('log',             (_e, v) => cb(v)),
    onCompleted:      (cb) => ipcRenderer.on('completed',       (_e, v) => cb(v)),
    onEncoderInfo:    (cb) => ipcRenderer.on('encoder-info',    (_e, v) => cb(v)),

    // Static data
    videoExtensions: VIDEO_EXTENSIONS
});
