<script lang="ts">
  import type { AudioAnalysis } from '../lib/tauri'
  import type { Range } from '../lib/silence'

  let { analysis, ranges, currentTime, onSeek }: {
    analysis: AudioAnalysis
    ranges: Range[]
    currentTime: number
    onSeek: (t: number) => void
  } = $props()

  const H = 96
  const RULER = 18
  const MAX_PPS = 600

  let canvas = $state<HTMLCanvasElement>()
  let width = $state(600)
  let pps = $state(0) // pixels per second (zoom level)
  let offset = $state(0) // time (s) at the left edge
  let needReset = $state(false)

  const dur = $derived(analysis.duration || 1)
  const minPps = $derived(width / dur) // fit-to-width == fully zoomed out
  const maxPps = $derived(Math.max(MAX_PPS, minPps))
  const defaultPps = $derived(Math.min(maxPps, minPps * Math.pow(maxPps / minPps, 0.25))) // slider at 25%

  const cut = $derived(ranges.reduce((s, r) => s + (r.end - r.start), 0))
  const kept = $derived(Math.max(0, dur - cut))

  // Zoom slider position (0..1, log scale between fit and max).
  const zoomDenom = $derived(Math.log(maxPps / minPps))
  const zoomVal = $derived(zoomDenom > 0 ? Math.max(0, Math.min(1, Math.log(pps / minPps) / zoomDenom)) : 0)

  // Reset to the centered default whenever a new video loads.
  $effect(() => {
    void analysis
    needReset = true
  })
  $effect(() => {
    if (width <= 0) return
    if (needReset) {
      pps = defaultPps
      offset = 0
      needReset = false
    } else if (pps < minPps) {
      pps = minPps
      offset = clampOffset(offset)
    }
  })

  const clampOffset = (o: number) => {
    const max = Math.max(0, dur - width / pps)
    return Math.min(max, Math.max(0, o))
  }

  // Set zoom from the slider (0..1), keeping the viewport center fixed.
  function setZoom(s: number) {
    if (zoomDenom <= 0) return
    const np = Math.min(maxPps, Math.max(minPps, minPps * Math.pow(maxPps / minPps, s)))
    const centerT = offset + width / 2 / pps
    pps = np
    offset = clampOffset(centerT - width / 2 / pps)
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

  const STEPS = [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]

  function draw() {
    if (!canvas || pps <= 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = H * dpr
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, H)

    const bucketS = analysis.bucketMs / 1000
    const peaks = analysis.peaks
    const wfTop = RULER
    const wfH = H - RULER
    const mid = wfTop + wfH / 2
    const amp = wfH / 2 - 3

    // waveform (one bar per pixel column)
    ctx.fillStyle = 'rgba(235, 235, 245, 0.32)'
    for (let x = 0; x < width; x++) {
      const t = offset + x / pps
      const i = Math.floor(t / bucketS)
      if (i < 0 || i >= peaks.length) continue
      const h = Math.max(0.75, peaks[i] * amp)
      ctx.fillRect(x, mid - h, 1, h * 2)
    }

    // cut (silence) regions
    for (const r of ranges) {
      const x1 = (r.start - offset) * pps
      const x2 = (r.end - offset) * pps
      if (x2 < 0 || x1 > width) continue
      ctx.fillStyle = 'rgba(99, 102, 241, 0.22)'
      ctx.fillRect(x1, wfTop, x2 - x1, wfH)
      ctx.fillStyle = 'rgba(129, 132, 255, 0.9)'
      ctx.fillRect(x1, wfTop, 1, wfH)
      ctx.fillRect(x2 - 1, wfTop, 1, wfH)
    }

    // ruler
    const visible = width / pps
    const target = visible / Math.max(2, width / 72)
    const step = STEPS.find((s) => s >= target) ?? STEPS[STEPS.length - 1]
    ctx.fillStyle = 'rgba(235, 235, 245, 0.5)'
    ctx.font = '10px -apple-system, system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    const first = Math.ceil(offset / step) * step
    for (let t = first; t < offset + visible; t += step) {
      const x = (t - offset) * pps
      ctx.fillStyle = 'rgba(235, 235, 245, 0.15)'
      ctx.fillRect(x, RULER, 1, H - RULER)
      ctx.fillStyle = 'rgba(235, 235, 245, 0.5)'
      ctx.fillText(fmt(t), x + 3, RULER / 2)
    }

    // playhead
    const px = (currentTime - offset) * pps
    if (px >= 0 && px <= width) {
      ctx.fillStyle = '#fff'
      ctx.fillRect(px - 0.5, 0, 1.5, H)
    }
  }

  $effect(() => {
    void [width, pps, offset, currentTime, ranges, analysis, canvas]
    draw()
  })

  function onWheel(e: WheelEvent) {
    e.preventDefault()
    const rect = canvas!.getBoundingClientRect()
    const cx = e.clientX - rect.left
    if (e.ctrlKey) {
      // pinch / ctrl+scroll → zoom, keeping the time under the cursor fixed
      const tAt = offset + cx / pps
      const factor = Math.exp(-e.deltaY * 0.01)
      pps = Math.min(MAX_PPS, Math.max(minPps, pps * factor))
      offset = clampOffset(tAt - cx / pps)
    } else {
      offset = clampOffset(offset + (e.deltaX || e.deltaY) / pps)
    }
  }

  let dragging = false
  let dragStartX = 0
  let dragStartOffset = 0
  let moved = false

  function onPointerDown(e: PointerEvent) {
    dragging = true
    moved = false
    dragStartX = e.clientX
    dragStartOffset = offset
    canvas!.setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return
    const dx = e.clientX - dragStartX
    if (Math.abs(dx) > 3) moved = true
    offset = clampOffset(dragStartOffset - dx / pps)
  }
  function onPointerUp(e: PointerEvent) {
    if (dragging && !moved) {
      const rect = canvas!.getBoundingClientRect()
      onSeek(offset + (e.clientX - rect.left) / pps)
    }
    dragging = false
  }
</script>

<div class="tl-root">
  <div class="tl-toolbar">
    <div class="tl-meta">{fmt(currentTime)} / {fmt(dur)} · {ranges.length} cut(s) · keep <span class="tl-keep">{fmt(kept)}</span> <span class="tl-cut">(−{fmt(cut)})</span></div>
    <div class="zoom">
      <button class="zoom-btn" aria-label="Zoom out" onclick={() => setZoom(Math.max(0, zoomVal - 0.15))}>−</button>
      <input
        class="zoom-range"
        type="range"
        min="0"
        max="1"
        step="0.001"
        value={zoomVal}
        oninput={(e) => setZoom(+e.currentTarget.value)}
      />
      <button class="zoom-btn" aria-label="Zoom in" onclick={() => setZoom(Math.min(1, zoomVal + 0.15))}>+</button>
    </div>
  </div>
  <div class="timeline" bind:clientWidth={width} style="height:{H}px">
    <canvas
      bind:this={canvas}
      style="width:{width}px;height:{H}px"
      onwheel={onWheel}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
    ></canvas>
  </div>
</div>

<style>
  .tl-root {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .tl-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 4px 12px;
    min-height: 20px;
  }
  .tl-meta {
    font-variant-numeric: tabular-nums;
    color: var(--text-2, rgba(235, 235, 245, 0.6));
    font-size: 12px;
    white-space: nowrap;
  }
  .zoom {
    flex-shrink: 0;
  }
  .tl-keep {
    color: var(--text, #fff);
    font-weight: 600;
  }
  .tl-cut {
    color: #32d74b;
    font-weight: 600;
  }
  .timeline {
    position: relative;
    width: 100%;
    background: var(--field, #1c1c1e);
    border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
    border-radius: var(--radius-group, 8px);
    overflow: hidden;
  }
  .zoom {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 999px;
  }
  .zoom-btn {
    width: 16px;
    height: 16px;
    display: grid;
    place-items: center;
    padding: 0;
    border: none;
    background: transparent;
    color: rgba(235, 235, 245, 0.7);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }
  .zoom-btn:hover {
    color: #fff;
  }
  .zoom-range {
    width: 86px;
    height: 3px;
    accent-color: var(--accent, #6366f1);
    cursor: pointer;
  }
  canvas {
    display: block;
    cursor: grab;
    touch-action: none;
  }
  canvas:active {
    cursor: grabbing;
  }
</style>
