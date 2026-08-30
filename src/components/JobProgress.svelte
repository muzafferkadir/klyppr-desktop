<script lang="ts">
  import { job, cancel } from '../lib/job.svelte'

  const phaseLabel: Record<string, string> = {
    probe: 'Analyzing file',
    detect: 'Detecting silence',
    measure: 'Measuring loudness',
    encode: 'Encoding',
    verify: 'Verifying',
  }

  const pct = $derived(Math.round(job.progress * 100))
  const label = $derived(job.phase ? phaseLabel[job.phase] ?? job.phase : 'Starting…')
</script>

<div class="progress">
  <div class="head">
    <span class="label">{label}</span>
    <span class="pct">{pct}%</span>
  </div>
  <div class="bar"><div class="fill" style="width:{pct}%"></div></div>
  <button class="cancel" onclick={cancel}>Cancel</button>
</div>

<style>
  .progress {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-4);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-1);
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .label {
    font-weight: 500;
  }
  .pct {
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }
  .bar {
    height: 8px;
    background: var(--surface-2);
    border-radius: 999px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    border-radius: 999px;
    transition: width 0.2s ease;
  }
  .cancel {
    align-self: flex-end;
    padding: 6px 14px;
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    background: var(--surface);
    color: var(--danger);
    cursor: pointer;
    font-size: 13px;
  }
  .cancel:hover {
    border-color: var(--danger);
  }
</style>
