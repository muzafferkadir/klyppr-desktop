<script lang="ts">
  import { revealItemInDir } from '@tauri-apps/plugin-opener'
  import { job } from '../lib/job.svelte'

  let { onDismiss }: { onDismiss: () => void } = $props()

  const result = $derived(job.result)

  async function reveal() {
    if (result?.ok) await revealItemInDir(result.outputPath)
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onDismiss()} />

{#if result}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={onDismiss} role="presentation">
    <div class="dialog" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
      {#if result.ok}
        <div class="icon ok">✓</div>
        <h2>Done</h2>
        <p class="path">{result.outputPath}</p>
        <div class="actions">
          <button class="secondary" onclick={onDismiss}>Close</button>
          <button class="primary" onclick={reveal}>Show in folder</button>
        </div>
      {:else if result.cancelled}
        <div class="icon warn">⊘</div>
        <h2>Cancelled</h2>
        <div class="actions"><button class="primary" onclick={onDismiss}>OK</button></div>
      {:else}
        <div class="icon err">!</div>
        <h2>Failed</h2>
        <p class="path err-text">{result.error}</p>
        <div class="actions"><button class="primary" onclick={onDismiss}>OK</button></div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
  }
  .dialog {
    width: 380px;
    max-width: 90vw;
    padding: var(--sp-5);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-2);
    text-align: center;
  }
  .icon {
    width: 44px;
    height: 44px;
    margin: 0 auto var(--sp-3);
    border-radius: 999px;
    display: grid;
    place-items: center;
    font-size: 22px;
    color: #fff;
  }
  .icon.ok { background: var(--success); }
  .icon.warn { background: var(--warn); }
  .icon.err { background: var(--danger); }
  h2 { margin: 0 0 var(--sp-2); }
  .path {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-muted);
    word-break: break-all;
    margin: 0 0 var(--sp-4);
  }
  .path.err-text { color: var(--danger); }
  .actions {
    display: flex;
    gap: var(--sp-2);
    justify-content: center;
  }
  .actions button {
    padding: 8px 16px;
    border-radius: var(--r-sm);
    font-size: 13px;
    cursor: pointer;
    border: 1px solid var(--border-strong);
  }
  .primary {
    background: var(--accent);
    color: var(--accent-contrast);
    border-color: var(--accent);
  }
  .secondary {
    background: var(--surface);
    color: var(--text);
  }
</style>
