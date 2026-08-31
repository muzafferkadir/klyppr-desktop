<script lang="ts">
  import { convertFileSrc } from '@tauri-apps/api/core'
  import type { AudioAnalysis } from '../lib/tauri'
  import type { Range } from '../lib/silence'

  let { inputPath, analysis, ranges, onReset }: {
    inputPath: string
    analysis: AudioAnalysis
    ranges: Range[]
    onReset: () => void
  } = $props()

  const src = $derived(convertFileSrc(inputPath))
  let video = $state<HTMLVideoElement | undefined>()
  let currentTime = $state(0)
  let videoError = $state(false)

  const kept = $derived(Math.max(0, analysis.duration - ranges.reduce((s, r) => s + (r.end - r.start), 0)))
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

  // Cut preview: skip over silence ranges during playback.
  function onTimeUpdate() {
    if (!video) return
    currentTime = video.currentTime
    const inCut = ranges.find((r) => currentTime >= r.start && currentTime < r.end - 0.03)
    if (inCut) video.currentTime = inCut.end
  }
</script>

<div class="stage">
  <div class="preview">
    <button class="close" onclick={onReset} aria-label="Choose another video" title="Choose another video">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
    </button>
    {#if videoError}
      <div class="novideo">Preview unavailable for this format — the timeline and export still work.</div>
    {:else}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={video} {src} ontimeupdate={onTimeUpdate} onerror={() => (videoError = true)} controls></video>
    {/if}
  </div>
  <div class="meta">{fmt(currentTime)} / {fmt(analysis.duration)} · {ranges.length} cut(s) · keep {fmt(kept)}</div>
</div>

<style>
  .stage { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; }
  .preview { position: relative; flex: 1; min-height: 0; display: flex; justify-content: center; }
  .close {
    position: absolute; top: 8px; right: 8px; z-index: 2;
    width: 30px; height: 30px; border-radius: 999px;
    background: rgba(0, 0, 0, 0.55); color: #fff; border: none;
    display: grid; place-items: center; cursor: pointer; opacity: 0.85;
  }
  .close:hover { opacity: 1; background: rgba(0, 0, 0, 0.75); }
  video, .novideo { width: 100%; height: 100%; min-height: 0; background: #000; border-radius: var(--radius-group); }
  video { object-fit: contain; }
  .novideo { display: grid; place-items: center; text-align: center; padding: 24px; color: var(--text-2); background: var(--field); }
  .meta { font-variant-numeric: tabular-nums; color: var(--text-2); font-size: 12px; }
</style>
