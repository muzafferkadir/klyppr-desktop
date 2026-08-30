<script lang="ts">
  import { onMount } from 'svelte'
  import FilePicker from './components/FilePicker.svelte'
  import ProcessingSettings from './components/ProcessingSettings.svelte'
  import JobProgress from './components/JobProgress.svelte'
  import LogPanel from './components/LogPanel.svelte'
  import CompletionDialog from './components/CompletionDialog.svelte'
  import UpdateBanner from './components/UpdateBanner.svelte'
  import { listen } from '@tauri-apps/api/event'
  import { job, run, initJobEvents } from './lib/job.svelte'
  import type { Settings } from './lib/tauri'

  // First-launch ffmpeg download overlay (emitted by the backend).
  let setup = $state({ preparing: false, fraction: 0, binary: '' })
  onMount(() => {
    const unlisten = listen<{ phase: string; binary?: string; fraction?: number }>('ffmpeg-setup', (e) => {
      const p = e.payload
      if (p.phase === 'ready') setup.preparing = false
      else {
        setup.preparing = true
        if (p.binary) setup.binary = p.binary
        if (typeof p.fraction === 'number') setup.fraction = p.fraction
      }
    })
    return () => void unlisten.then((f) => f())
  })

  let inputPath = $state('')
  let outputDir = $state('')
  let settings = $state<Settings>({
    silenceDb: -30,
    minSilence: 0.5,
    padding: 0.05,
    quality: 'medium',
    normalizeAudio: true,
    useHardware: true,
  })
  let showDialog = $state(false)

  const canStart = $derived(!!inputPath && !!outputDir && !job.running)

  onMount(initJobEvents)

  // Surface the completion dialog whenever a job produces a result.
  $effect(() => {
    if (job.result) showDialog = true
  })

  function start() {
    showDialog = false
    run({ inputPath, outputDir, ...settings })
  }
</script>

<main>
  <header data-tauri-drag-region>
    <h1>Klyppr</h1>
    <p>Cut silence from video, keep it in sync.</p>
  </header>

  <section class="content">
    <UpdateBanner />
    <FilePicker bind:inputPath bind:outputDir />
    <ProcessingSettings bind:settings disabled={job.running} />

    {#if job.running}
      <JobProgress />
    {:else}
      <button class="start" onclick={start} disabled={!canStart}>Start</button>
    {/if}

    <LogPanel />
  </section>
</main>

{#if showDialog}
  <CompletionDialog onDismiss={() => (showDialog = false)} />
{/if}

{#if setup.preparing}
  <div class="setup-overlay">
    <div class="setup-card">
      <div class="spinner"></div>
      <h2>Preparing FFmpeg</h2>
      <p>One-time download of the {setup.binary || 'video'} engine…</p>
      <div class="bar"><div class="fill" style="width:{Math.round(setup.fraction * 100)}%"></div></div>
    </div>
  </div>
{/if}

<style>
  main {
    max-width: 640px;
    margin: 0 auto;
    padding: var(--sp-5) var(--sp-5) var(--sp-6);
  }
  header {
    padding: var(--sp-4) 0 var(--sp-5);
    text-align: center;
  }
  header h1 {
    margin: 0;
    font-size: 28px;
    letter-spacing: -0.02em;
  }
  header p {
    margin: 4px 0 0;
    color: var(--text-muted);
  }
  .content {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }
  .start {
    padding: 12px;
    font-size: 15px;
    font-weight: 600;
    color: var(--accent-contrast);
    background: var(--accent);
    border: none;
    border-radius: var(--r-md);
    cursor: pointer;
    box-shadow: var(--shadow-1);
    transition: background 0.15s;
  }
  .start:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  .start:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .setup-overlay {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    backdrop-filter: blur(6px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 20;
  }
  .setup-card {
    width: 320px;
    padding: var(--sp-5);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-2);
    text-align: center;
  }
  .setup-card h2 {
    margin: var(--sp-3) 0 var(--sp-1);
    font-size: 17px;
  }
  .setup-card p {
    margin: 0 0 var(--sp-4);
    color: var(--text-muted);
    font-size: 13px;
  }
  .spinner {
    width: 28px;
    height: 28px;
    margin: 0 auto;
    border: 3px solid var(--surface-2);
    border-top-color: var(--accent);
    border-radius: 999px;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .bar {
    height: 6px;
    background: var(--surface-2);
    border-radius: 999px;
    overflow: hidden;
  }
  .bar .fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s ease;
  }
</style>
