<script lang="ts">
  import { job } from '../lib/job.svelte'

  let box: HTMLDivElement | undefined
  // Autoscroll to newest line as logs grow.
  $effect(() => {
    void job.logs.length
    if (box) box.scrollTop = box.scrollHeight
  })
</script>

<div class="log" bind:this={box}>
  {#each job.logs as line}
    <div class="line" class:warn={line.level === 'warn'} class:err={line.level === 'error'}>{line.message}</div>
  {:else}
    <div class="empty">Logs will appear here during processing.</div>
  {/each}
</div>

<style>
  .log {
    height: 160px;
    overflow-y: auto;
    padding: var(--sp-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.55;
  }
  .line {
    color: var(--text-muted);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .line.warn {
    color: var(--warn);
  }
  .line.err {
    color: var(--danger);
  }
  .empty {
    color: var(--text-faint);
  }
</style>
