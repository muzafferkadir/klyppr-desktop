<script lang="ts">
  import { convertFileSrc } from '@tauri-apps/api/core'
  import { open } from '@tauri-apps/plugin-dialog'
  import { computeSilence, totalCut } from '../lib/silence'
  import { job, run, cancel } from '../lib/job.svelte'
  import type { AudioAnalysis, EncoderInfo, QualityPreset } from '../lib/tauri'

  let {
    inputPath,
    outputPath = $bindable(),
    analysis,
    encoder,
    onReset,
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
    onReset: () => void
    silenceDb: number
    minSilence: number
    padding: number
    quality: QualityPreset
    normalizeAudio: boolean
    useHardware: boolean
  } = $props()

  const presets = ['fast', 'medium', 'high', 'lossless'] as const

  // Cuts recompute live from the loudness envelope as sliders move.
  const ranges = $derived(
    computeSilence(analysis.envelopeDb, analysis.bucketMs, silenceDb, minSilence, padding),
  )
  const removed = $derived(totalCut(ranges))
  const kept = $derived(Math.max(0, analysis.duration - removed))

  const src = $derived(convertFileSrc(inputPath))
  let video = $state<HTMLVideoElement | undefined>()
  let currentTime = $state(0)
  let videoError = $state(false)

  // Cut preview: when playback enters a cut range, jump to its end.
  function onTimeUpdate() {
    if (!video) return
    currentTime = video.currentTime
    const inCut = ranges.find((r) => currentTime >= r.start && currentTime < r.end - 0.03)
    if (inCut) video.currentTime = inCut.end
  }

  async function pickOutput() {
    const d = await open({ directory: true })
    if (typeof d === 'string') outputPath = d
  }

  function exportVideo() {
    if (!outputPath) return
    run({
      inputPath,
      outputDir: outputPath,
      silenceDb,
      minSilence,
      padding,
      quality,
      normalizeAudio,
      useHardware,
      silenceRanges: ranges.map((r) => [r.start, r.end] as [number, number]),
    })
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
</script>

<div class="editor">
  <div class="stage">
    <div class="preview">
      {#if videoError}
        <div class="novideo">Preview unavailable for this format — the timeline and export still work.</div>
      {:else}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video bind:this={video} {src} ontimeupdate={onTimeUpdate} onerror={() => (videoError = true)} controls></video>
      {/if}
      <div class="timebar">{fmt(currentTime)} / {fmt(analysis.duration)}</div>
    </div>

    <aside class="panel">
      <button class="link" onclick={onReset}>← Choose another video</button>

      <label class="fld"><span>Silence threshold <em>{silenceDb} dB</em></span>
        <input type="range" min="-60" max="-10" step="1" bind:value={silenceDb} disabled={job.running} /></label>
      <label class="fld"><span>Min. silence <em>{minSilence.toFixed(2)}s</em></span>
        <input type="range" min="0.1" max="2" step="0.05" bind:value={minSilence} disabled={job.running} /></label>
      <label class="fld"><span>Padding <em>{padding.toFixed(2)}s</em></span>
        <input type="range" min="0" max="0.5" step="0.01" bind:value={padding} disabled={job.running} /></label>

      <label class="fld"><span>Quality</span>
        <select bind:value={quality} disabled={job.running}>
          {#each presets as p}<option value={p}>{p}</option>{/each}
        </select></label>

      <label class="chk"><input type="checkbox" bind:checked={normalizeAudio} disabled={job.running} /> Normalize −16 LUFS</label>
      {#if encoder.available}
        <label class="chk"><input type="checkbox" bind:checked={useHardware} disabled={job.running} /> GPU ({encoder.name})</label>
      {/if}

      <div class="summary">{ranges.length} cut(s) · keep {fmt(kept)} of {fmt(analysis.duration)}</div>

      <button class="out" onclick={pickOutput} disabled={job.running}>{outputPath ? '✓ output set' : 'Choose output folder…'}</button>

      {#if job.running}
        <div class="prog"><div class="fill" style="width:{Math.round(job.progress * 100)}%"></div></div>
        <button class="cancel" onclick={cancel}>Cancel</button>
      {:else}
        <button class="export" onclick={exportVideo} disabled={!outputPath}>Export</button>
      {/if}
    </aside>
  </div>

  <!-- P5: waveform timeline goes here -->
  <div class="timeline-placeholder">timeline (waveform + cuts) — coming next</div>
</div>

<style>
  .editor { display: flex; flex-direction: column; height: 100%; gap: 12px; padding: 12px 16px 16px; }
  .stage { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 16px; flex: 1; min-height: 0; }
  .preview { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  video { width: 100%; height: 100%; object-fit: contain; background: #000; border-radius: var(--radius-group); }
  .novideo { flex: 1; display: grid; place-items: center; text-align: center; padding: 24px; color: var(--text-2); background: var(--field); border-radius: var(--radius-group); }
  .timebar { font-variant-numeric: tabular-nums; color: var(--text-2); font-size: 12px; }
  .panel { display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
  .link { align-self: flex-start; background: none; color: var(--accent); padding: 0; font-size: 12px; }
  .fld { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-2); }
  .fld span { display: flex; justify-content: space-between; }
  .fld em { font-style: normal; color: var(--text); font-variant-numeric: tabular-nums; }
  .fld input[type='range'] { width: 100%; accent-color: var(--accent); }
  .fld select { height: 32px; background: var(--field); border: 1px solid var(--border); border-radius: var(--radius-field); color: var(--text); padding: 0 8px; }
  .chk { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .chk input { accent-color: var(--accent); }
  .summary { font-size: 12px; color: var(--text-2); padding: 6px 0; border-top: 1px solid var(--separator); }
  .out { height: 34px; background: var(--window-2); border: 1px solid var(--border-strong); border-radius: var(--radius-field); }
  .export, .cancel { height: 40px; font-size: 14px; font-weight: 600; border-radius: 8px; }
  .export { background: var(--accent); color: var(--accent-fg); }
  .export:disabled { background: rgba(255,255,255,0.08); color: var(--text-3); }
  .cancel { background: var(--window-2); border: 1px solid var(--border-strong); color: var(--danger); }
  .prog { height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; }
  .prog .fill { height: 100%; background: var(--accent); transition: width 0.3s; }
  .timeline-placeholder { height: 120px; display: grid; place-items: center; color: var(--text-3); background: var(--field); border: 1px solid var(--border); border-radius: var(--radius-group); font-size: 12px; }
</style>
