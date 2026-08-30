<script lang="ts">
  import { onMount } from 'svelte'
  import FilePicker from './components/FilePicker.svelte'
  import ProcessingSettings from './components/ProcessingSettings.svelte'
  import JobProgress from './components/JobProgress.svelte'
  import LogPanel from './components/LogPanel.svelte'
  import CompletionDialog from './components/CompletionDialog.svelte'
  import { job, run, initJobEvents } from './lib/job.svelte'
  import type { Settings } from './lib/tauri'

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
</style>
