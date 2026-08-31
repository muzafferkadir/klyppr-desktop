<script lang="ts">
  import { convertFileSrc } from '@tauri-apps/api/core'
  import type { AudioAnalysis } from '../lib/tauri'
  import type { Range } from '../lib/silence'

  let { inputPath, analysis, ranges, onReset, currentTime = $bindable(0) }: {
    inputPath: string
    analysis: AudioAnalysis
    ranges: Range[]
    onReset: () => void
    currentTime?: number
  } = $props()

  const src = $derived(convertFileSrc(inputPath))
  let video = $state<HTMLVideoElement | undefined>()
  let videoError = $state(false)

  /** Seek the video (called from the timeline). */
  export function seek(t: number) {
    if (!video) return
    video.currentTime = Math.max(0, Math.min(t, analysis.duration))
    currentTime = video.currentTime
  }

  // Cut preview: skip over silence ranges during playback.
  function onTimeUpdate() {
    if (!video) return
    currentTime = video.currentTime
    const inCut = ranges.find((r) => currentTime >= r.start && currentTime < r.end - 0.03)
    if (inCut) video.currentTime = inCut.end
  }
</script>

<div class="stage">
  <button class="close" type="button" onclick={onReset} aria-label="Choose another video" title="Choose another video">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
  </button>
  <div class="preview">
    {#if videoError}
      <div class="novideo">Preview unavailable for this format — the timeline and export still work.</div>
    {:else}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={video} {src} ontimeupdate={onTimeUpdate} onerror={() => (videoError = true)} controls></video>
    {/if}
  </div>
</div>

<style>
  .stage { position: relative; display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; }
  .preview { position: relative; flex: 1; min-height: 0; display: flex; justify-content: center; }
  .close {
    position: absolute; top: 8px; right: 8px; z-index: 30;
    width: 30px; height: 30px; border-radius: 999px;
    background: rgba(0, 0, 0, 0.55); color: #fff; border: none;
    display: grid; place-items: center; cursor: pointer; opacity: 0.85;
  }
  .close:hover { opacity: 1; background: rgba(0, 0, 0, 0.75); }
  video, .novideo { width: 100%; height: 100%; min-height: 0; background: #000; border-radius: var(--radius-group); }
  video { object-fit: contain; }
  .novideo { display: grid; place-items: center; text-align: center; padding: 24px; color: var(--text-2); background: var(--field); }
</style>
