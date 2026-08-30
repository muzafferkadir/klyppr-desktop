<script lang="ts">
  import { onMount } from 'svelte'
  import { listen } from '@tauri-apps/api/event'
  import { open } from '@tauri-apps/plugin-dialog'
  import { getCurrentWebview } from '@tauri-apps/api/webview'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { revealItemInDir } from '@tauri-apps/plugin-opener'
  import { check, type Update } from '@tauri-apps/plugin-updater'
  import { relaunch } from '@tauri-apps/plugin-process'
  import { job, run, cancel, initJobEvents } from './lib/job.svelte'
  import { getEncoderInfo, type QualityPreset } from './lib/tauri'

  const logo = '/logo.png'

  const VIDEO_EXTS = ['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'ts', 'm4v', 'wmv', '3gp', 'mpg', 'mpeg', 'mts', 'vob']

  const presets = {
    recommended: { silenceDb: -40, minSilence: 0.2, padding: 0.06 },
    fast: { silenceDb: -30, minSilence: 0.4, padding: 0.035 },
  }

  // ---- settings state (legacy defaults) ----
  let inputPath = $state('')
  let outputPath = $state('')
  let silenceDb = $state(-40)
  let minSilence = $state(0.2)
  let padding = $state(0.06)
  let quality = $state<QualityPreset>('lossless')
  let normalizeAudio = $state(true)
  let useHardware = $state(false)
  let activePreset = $state<'recommended' | 'fast' | null>('recommended')

  let encoder = $state({ available: false, name: '', description: '' })
  let dragOver = $state(false)
  let logExpanded = $state(false)
  let logCopied = $state(false)
  let showModal = $state(false)

  // ---- ffmpeg first-run download overlay + updater ----
  let setup = $state({ preparing: false, fraction: 0, binary: '' })
  let update = $state<Update | null>(null)
  let updateBusy = $state(false)

  const canStart = $derived(!!inputPath && !!outputPath && !job.running)

  const phaseLabel: Record<string, string> = {
    probe: 'Analyzing file', detect: 'Detecting silence', measure: 'Measuring loudness', encode: 'Encoding', verify: 'Verifying',
  }
  const statusText = $derived(
    !job.running && job.result
      ? job.result.ok ? 'Process completed!' : job.result.cancelled ? 'Processing cancelled' : `Error: ${job.result.error}`
      : job.phase ? `${phaseLabel[job.phase] ?? job.phase}: ${Math.round(job.progress * 100)}%` : 'Starting process...',
  )

  const SETTINGS_KEY = 'klyppr-settings'
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ silenceDb, minSilence, padding, quality, normalizeAudio, useHardware }))
    } catch {}
  }
  function restoreSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null')
      if (!s) return
      if (s.silenceDb != null) silenceDb = s.silenceDb
      if (s.minSilence != null) minSilence = s.minSilence
      if (s.padding != null) padding = s.padding
      if (s.quality != null) quality = s.quality
      if (s.normalizeAudio != null) normalizeAudio = s.normalizeAudio
      if (s.useHardware != null) useHardware = s.useHardware
      activePreset = null // saved values may not match a preset
    } catch {}
  }

  function applyPreset(name: 'recommended' | 'fast') {
    activePreset = name
    const p = presets[name]
    silenceDb = p.silenceDb
    minSilence = p.minSilence
    padding = p.padding
  }

  async function pickInput() {
    const f = await open({ multiple: false, filters: [{ name: 'Video', extensions: VIDEO_EXTS }] })
    if (typeof f === 'string') inputPath = f
  }
  async function pickOutput() {
    const d = await open({ directory: true })
    if (typeof d === 'string') outputPath = d
  }

  function start() {
    saveSettings()
    showModal = false
    logExpanded = false
    run({ inputPath, outputDir: outputPath, silenceDb, minSilence, padding, normalizeAudio, quality, useHardware })
  }

  async function copyLogs() {
    const text = job.logs.map((l) => l.message).join('\n')
    if (!text.trim()) return
    try {
      await navigator.clipboard.writeText(text)
      logCopied = true
      setTimeout(() => (logCopied = false), 2000)
    } catch {}
  }

  async function showInFolder() {
    if (job.result?.ok) await revealItemInDir(job.result.outputPath)
    showModal = false
  }

  async function installUpdate() {
    if (!update) return
    updateBusy = true
    try {
      await update.downloadAndInstall()
      await relaunch()
    } catch {
      updateBusy = false
    }
  }

  // completion modal opens when a job finishes successfully
  $effect(() => {
    if (job.result?.ok) showModal = true
  })

  let logBox = $state<HTMLDivElement | undefined>()
  $effect(() => {
    void job.logs.length
    if (logBox && logExpanded) logBox.scrollTop = logBox.scrollHeight
  })

  onMount(() => {
    initJobEvents()

    getEncoderInfo().then((info) => {
      encoder = info
      if (info.available) useHardware = true // GPU on by default when available
      restoreSettings() // saved preference overrides the default
    }).catch(() => restoreSettings())

    const unSetup = listen<{ phase: string; binary?: string; fraction?: number }>('ffmpeg-setup', (e) => {
      const p = e.payload
      if (p.phase === 'ready') setup.preparing = false
      else { setup.preparing = true; if (p.binary) setup.binary = p.binary; if (typeof p.fraction === 'number') setup.fraction = p.fraction }
    })

    const unDrag = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === 'over') dragOver = true
      else if (e.payload.type === 'leave') dragOver = false
      else if (e.payload.type === 'drop') {
        dragOver = false
        const p = e.payload.paths?.[0]
        if (p && VIDEO_EXTS.includes(p.split('.').pop()!.toLowerCase())) inputPath = p
      }
    })

    check().then((u) => { if (u?.available) update = u }).catch(() => {})

    return () => { void unSetup.then((f) => f()); void unDrag.then((f) => f()) }
  })
</script>

<div class="app-wrapper">
  <div class="container">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <header
      class="header"
      onmousedown={(e) => { if (e.button === 0) getCurrentWindow().startDragging() }}
      ondblclick={() => getCurrentWindow().toggleMaximize()}
    >
      <div class="brand">
        <span class="logo-badge"><img class="logo-icon" src={logo} alt="Klyppr" /></span>
        <span class="brand-text">
          <span class="title">Klyppr</span>
          <span class="subtitle">Automatic Video Silence Clipper</span>
        </span>
      </div>
    </header>

    {#if update}
      <div class="update-bar">
        <span>Version {update.version} is available.</span>
        <button onclick={installUpdate} disabled={updateBusy}>{updateBusy ? 'Updating…' : 'Update'}</button>
      </div>
    {/if}

    <main class="main-content">
      <div class="content-grid">
        <!-- Left: files & presets -->
        <div class="col col-left">
          <section class="card">
            <h3 class="section-title">
              <svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" /><path d="M13 2v7h7" /></svg>
              Files
            </h3>
            <div class="file-selection">
              <div class="form-group">
                <label class="form-label" for="inputPath">Input Video</label>
                <div class="input-group" class:drag-over={dragOver}>
                  <input id="inputPath" type="text" readonly value={inputPath} placeholder="Select or drop video file..." class="file-input" />
                  <button class="browse-btn" onclick={pickInput} data-tooltip="Browse for video">
                    <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                    <span class="btn-text">Browse</span>
                  </button>
                </div>
                <span class="field-hint">Drag &amp; drop a video anywhere on this window</span>
              </div>
              <div class="form-group">
                <label class="form-label" for="outputPath">Output Folder</label>
                <div class="input-group">
                  <input id="outputPath" type="text" readonly value={outputPath} placeholder="Select output folder..." class="file-input" />
                  <button class="browse-btn" onclick={pickOutput} data-tooltip="Browse for folder">
                    <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                    <span class="btn-text">Browse</span>
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section class="card presets-section">
            <h3 class="section-title">
              <svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
              Quick Presets
            </h3>
            <div class="button-group">
              <button class="preset-btn" class:active={activePreset === 'recommended'} onclick={() => applyPreset('recommended')} data-tooltip="Balanced quality and speed">
                <span class="preset-name">Recommended</span>
                <span class="preset-desc">Balanced quality</span>
              </button>
              <button class="preset-btn" class:active={activePreset === 'fast'} onclick={() => applyPreset('fast')} data-tooltip="Faster processing, more aggressive">
                <span class="preset-name">Aggressive</span>
                <span class="preset-desc">Tight detection</span>
              </button>
            </div>
          </section>
        </div>

        <!-- Right: settings -->
        <div class="col col-right">
          <section class="card settings-section">
            <h3 class="section-title">
              <svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15a3 3 0 100-6 3 3 0 000 6z" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" /></svg>
              Advanced Settings
            </h3>
            <div class="settings-group visible">
              <div class="settings-grid">
                <div class="form-group">
                  <label class="form-label" for="silenceDb" data-tooltip="Lower values = more sensitive">Silence Threshold <span class="unit">dB</span></label>
                  <input id="silenceDb" type="number" bind:value={silenceDb} step="1" class="number-input" />
                </div>
                <div class="form-group">
                  <label class="form-label" for="minSilence" data-tooltip="Minimum silence duration to detect">Min. Silence <span class="unit">sec</span></label>
                  <input id="minSilence" type="number" bind:value={minSilence} step="0.1" min="0" class="number-input" />
                </div>
                <div class="form-group">
                  <label class="form-label" for="padding" data-tooltip="Keep this much audio before/after silence">Padding <span class="unit">sec</span></label>
                  <input id="padding" type="number" bind:value={padding} step="0.01" min="0" class="number-input" />
                </div>
                <div class="form-group form-group-wide">
                  <label class="form-label" for="quality" data-tooltip="Higher quality = slower processing">Video Quality</label>
                  <select id="quality" bind:value={quality} class="select-input">
                    <option value="lossless">Lossless (No Quality Loss, Largest File)</option>
                    <option value="high">High (Best Quality, Slower)</option>
                    <option value="medium">Medium (Balanced)</option>
                    <option value="fast">Fast (Lower Quality, Faster)</option>
                  </select>
                </div>
              </div>

              <div class="checkbox-group">
                <label class="checkbox-label" for="normalizeAudio" data-tooltip="Normalize audio to YouTube standards">
                  <span class="checkbox-text">
                    <span class="checkbox-title">
                      <svg class="checkbox-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 7H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" /></svg>
                      Normalize Audio (YouTube Standard)
                    </span>
                    <span class="checkbox-desc">Adjust volume to -16 LUFS (MrBeast/YouTube level)</span>
                  </span>
                  <input id="normalizeAudio" type="checkbox" bind:checked={normalizeAudio} class="checkbox-input" />
                </label>

                {#if encoder.available}
                  <label class="checkbox-label" for="useHardware" data-tooltip="Use GPU for faster video encoding">
                    <span class="checkbox-text">
                      <span class="checkbox-title">
                        <svg class="checkbox-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" /><line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" /><line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" /><line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" /></svg>
                        GPU Acceleration ({encoder.name})
                      </span>
                      <span class="checkbox-desc">{encoder.description}</span>
                    </span>
                    <input id="useHardware" type="checkbox" bind:checked={useHardware} class="checkbox-input" />
                  </label>
                {/if}
              </div>
            </div>
          </section>
        </div>
      </div>

      <section class="action-section">
        {#if job.running}
          <button class="cancel-btn" onclick={cancel} data-tooltip="Cancel current processing">
            <svg class="btn-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
            <span class="btn-text">Cancel</span>
          </button>
        {:else}
          <button class="start-btn" disabled={!canStart} onclick={start} data-tooltip={canStart ? 'Start processing video' : 'Select input and output first'}>
            <svg class="btn-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20 6 4" /></svg>
            <span class="btn-text">Start Processing</span>
          </button>
        {/if}
      </section>

      {#if job.running || job.result}
        <section class="progress-section">
          <div class="progress-container" style="display:block">
            <div class="progress-info">
              <span class="progress-label">Status</span>
              <span class="progress-status">{statusText}</span>
            </div>
            <div class="progress-bar">
              <div class="progress-bar-fill" style="width:{Math.round(job.progress * 100)}%"></div>
            </div>
          </div>
        </section>
      {/if}

      {#if job.running || job.logs.length}
        <section class="log-section">
          <div class="log-header">
            <button class="log-toggle" onclick={() => (logExpanded = !logExpanded)}>
              <span class="log-toggle-text">{logExpanded ? 'Hide' : 'Show'} Processing Logs</span>
              <span class="log-toggle-icon">{logExpanded ? '▲' : '▼'}</span>
            </button>
            <button class="log-copy-btn" class:copied={logCopied} onclick={copyLogs}>
              <svg class="log-copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
              <span class="log-copy-text">{logCopied ? 'Copied!' : 'Copy'}</span>
            </button>
          </div>
          {#if logExpanded}
            <div class="log-container-wrapper">
              <div class="log-container" bind:this={logBox}>
                {#each job.logs as line}<div>{line.message}</div>{/each}
              </div>
            </div>
          {/if}
        </section>
      {/if}
    </main>
  </div>
</div>

<!-- Completion modal -->
<div class="modal" style="display:{showModal ? 'flex' : 'none'}">
  <div class="modal-backdrop" onclick={() => (showModal = false)} role="presentation"></div>
  <div class="modal-content">
    <button class="modal-close" onclick={() => (showModal = false)} aria-label="Close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
    </button>
    <div class="modal-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
    </div>
    <h2 class="modal-title">Processing Complete</h2>
    <p class="modal-text">Your video has been successfully processed and is ready to use.</p>
    <div class="modal-buttons">
      <button class="modal-btn modal-btn-primary" onclick={showInFolder}>
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /><path d="M12 11v6M9 14l3 3 3-3" /></svg>
        Show in Folder
      </button>
      <button class="modal-btn modal-btn-secondary" onclick={() => (showModal = false)}>
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        Close
      </button>
    </div>
  </div>
</div>

<!-- First-run ffmpeg download overlay -->
{#if setup.preparing}
  <div class="modal" style="display:flex">
    <div class="modal-backdrop"></div>
    <div class="modal-content">
      <div class="modal-icon" style="background:rgba(99,102,241,0.16);color:var(--accent)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" /></svg>
      </div>
      <h2 class="modal-title">Preparing FFmpeg</h2>
      <p class="modal-text">One-time download of the {setup.binary || 'video'} engine…</p>
      <div class="progress-bar"><div class="progress-bar-fill" style="width:{Math.round(setup.fraction * 100)}%"></div></div>
    </div>
  </div>
{/if}

<style>
  .update-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 20px;
    background: rgba(99, 102, 241, 0.16);
    border-bottom: 1px solid var(--separator);
    font-size: 12px;
    color: var(--text);
  }
  .update-bar button {
    height: 26px;
    padding: 0 12px;
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 12px;
    font-weight: 600;
    border-radius: var(--radius-field);
  }
  .update-bar button:disabled { opacity: 0.6; }
</style>
