<script lang="ts">
  import { convertFileSrc } from '@tauri-apps/api/core'
  import { open } from '@tauri-apps/plugin-dialog'
  import { computeSilence, totalCut } from '../lib/silence'
  import { job, run, cancel } from '../lib/job.svelte'
  import SettingsPanel from './SettingsPanel.svelte'
  import type { AudioAnalysis, EncoderInfo, QualityPreset } from '../lib/tauri'

  let {
    inputPath,
    outputPath = $bindable(),
    analysis,
    encoder,
    silenceDb = $bindable(),
    minSilence = $bindable(),
    padding = $bindable(),
    quality = $bindable(),
    normalizeAudio = $bindable(),
    useHardware = $bindable(),
  }: {
    inputPath: string
    outputPath: string
    analysis: AudioAnalysis
    encoder: EncoderInfo
    silenceDb: number
    minSilence: number
    padding: number
    quality: QualityPreset
    normalizeAudio: boolean
    useHardware: boolean
  } = $props()

  const ranges = $derived(computeSilence(analysis.envelopeDb, analysis.bucketMs, silenceDb, minSilence, padding))
  const kept = $derived(Math.max(0, analysis.duration - totalCut(ranges)))

  const src = $derived(convertFileSrc(inputPath))
  let video = $state<HTMLVideoElement | undefined>()
  let currentTime = $state(0)
  let videoError = $state(false)
  let logExpanded = $state(false)
  let logBox = $state<HTMLDivElement | undefined>()

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

  function onTimeUpdate() {
    if (!video) return
    currentTime = video.currentTime
    const inCut = ranges.find((r) => currentTime >= r.start && currentTime < r.end - 0.03)
    if (inCut) video.currentTime = inCut.end
  }

  async function startProcess() {
    if (!outputPath) {
      const d = await open({ directory: true })
      if (typeof d !== 'string') return
      outputPath = d
    }
    run({
      inputPath, outputDir: outputPath,
      silenceDb, minSilence, padding, quality, normalizeAudio, useHardware,
      silenceRanges: ranges.map((r) => [r.start, r.end] as [number, number]),
    })
  }

  $effect(() => {
    void job.logs.length
    if (logBox && logExpanded) logBox.scrollTop = logBox.scrollHeight
  })
</script>

<div class="editor">
  <div class="top">
    <div class="preview">
      {#if videoError}
        <div class="novideo">Preview unavailable for this format — the timeline and export still work.</div>
      {:else}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video bind:this={video} {src} ontimeupdate={onTimeUpdate} onerror={() => (videoError = true)} controls></video>
      {/if}
      <div class="timebar">{fmt(currentTime)} / {fmt(analysis.duration)} · {ranges.length} cut(s) · keep {fmt(kept)}</div>
    </div>

    <aside class="side">
      <SettingsPanel compact bind:silenceDb bind:minSilence bind:padding bind:quality bind:normalizeAudio bind:useHardware {encoder} disabled={job.running} />
    </aside>
  </div>

  <!-- P5: waveform + cuts render here -->
  <div class="timeline-placeholder">timeline (waveform + cuts) — coming next</div>

  {#if job.running}
    <div class="startrow">
      <div class="prog"><div class="fill" style="width:{Math.round(job.progress * 100)}%"></div></div>
      <button class="cancel-btn" onclick={cancel}><span class="btn-text">Cancel</span></button>
    </div>
  {:else}
    <button class="start-btn" onclick={startProcess} data-tooltip="Process the video">
      <svg class="btn-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20 6 4" /></svg>
      <span class="btn-text">{ranges.length ? `Process ${ranges.length} cut(s)` : 'Start Process'}</span>
    </button>
  {/if}

  <section class="log-section">
    <div class="log-header">
      <button class="log-toggle" onclick={() => (logExpanded = !logExpanded)}>
        <span class="log-toggle-text">{logExpanded ? 'Hide' : 'Show'} Logs</span>
        <span class="log-toggle-icon">{logExpanded ? '▲' : '▼'}</span>
      </button>
    </div>
    {#if logExpanded}
      <div class="log-container-wrapper">
        <div class="log-container" bind:this={logBox}>
          {#each job.logs as line}<div>{line.message}</div>{:else}<div>Logs will appear here during processing.</div>{/each}
        </div>
      </div>
    {/if}
  </section>
</div>

<style>
  /* Fixed layout — no page scroll (codex). Only the side column and open log
     content scroll. Preview fills the remaining top-area height. */
  .editor { display: flex; flex-direction: column; height: 100%; gap: 10px; padding: 12px 16px 14px; overflow: hidden; }
  .top { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 14px; }
  .preview { display: flex; flex-direction: column; gap: 6px; min-width: 0; justify-content: center; }
  video, .novideo { width: 100%; max-height: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: var(--radius-group); min-height: 0; }
  video { object-fit: contain; }
  .novideo { display: grid; place-items: center; text-align: center; padding: 24px; color: var(--text-2); background: var(--field); }
  .timebar { font-variant-numeric: tabular-nums; color: var(--text-2); font-size: 12px; flex: none; }
  .side { display: flex; flex-direction: column; gap: 12px; min-width: 0; overflow-y: auto; }
  .timeline-placeholder { flex: none; height: 92px; display: grid; place-items: center; color: var(--text-3); background: var(--field); border: 1px solid var(--border); border-radius: var(--radius-group); font-size: 12px; }
  .log-section, .start-btn, .cancel-btn, .startrow { flex: none; }
  .log-container { max-height: 130px; }
  .start-btn, .cancel-btn { width: 100%; height: 48px; font-size: 15px; font-weight: 600; border-radius: 8px; }
  .start-btn { background: var(--accent); color: var(--accent-fg); }
  .start-btn:disabled { background: rgba(255,255,255,0.08); color: var(--text-3); }
  .cancel-btn { background: var(--window-2); border: 1px solid var(--border-strong); color: var(--danger); }
  .startrow { display: flex; align-items: center; gap: 12px; }
  .startrow .prog { flex: 1; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; }
  .startrow .fill { height: 100%; background: var(--accent); transition: width 0.3s; }
  .startrow .cancel-btn { width: auto; padding: 0 20px; height: 40px; }
</style>
