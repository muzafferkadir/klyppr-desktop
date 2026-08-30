<script lang="ts">
  import type { QualityPreset, Settings } from '../lib/tauri'

  let { settings = $bindable(), disabled = false }: {
    settings: Settings
    disabled?: boolean
  } = $props()

  const presets: QualityPreset[] = ['fast', 'medium', 'high', 'lossless']
</script>

<div class="settings" class:disabled>
  <label class="row">
    <span class="k">Silence threshold <em>{settings.silenceDb} dB</em></span>
    <input type="range" min="-60" max="-10" step="1" bind:value={settings.silenceDb} {disabled} />
  </label>

  <label class="row">
    <span class="k">Min silence <em>{settings.minSilence.toFixed(2)} s</em></span>
    <input type="range" min="0.1" max="3" step="0.05" bind:value={settings.minSilence} {disabled} />
  </label>

  <label class="row">
    <span class="k">Padding <em>{settings.padding.toFixed(2)} s</em></span>
    <input type="range" min="0" max="0.5" step="0.01" bind:value={settings.padding} {disabled} />
  </label>

  <div class="row">
    <span class="k">Quality</span>
    <div class="segmented">
      {#each presets as p}
        <button
          class:active={settings.quality === p}
          onclick={() => (settings.quality = p)}
          {disabled}
        >{p}</button>
      {/each}
    </div>
  </div>

  <label class="toggle">
    <input type="checkbox" bind:checked={settings.normalizeAudio} {disabled} />
    <span>Normalize loudness (−16 LUFS)</span>
  </label>

  <label class="toggle">
    <input type="checkbox" bind:checked={settings.useHardware} {disabled} />
    <span>Use hardware encoder when available</span>
  </label>
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    padding: var(--sp-4);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-1);
  }
  .settings.disabled {
    opacity: 0.55;
    pointer-events: none;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .k {
    font-size: 13px;
    color: var(--text-muted);
    display: flex;
    justify-content: space-between;
  }
  .k em {
    font-style: normal;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  input[type='range'] {
    width: 100%;
    accent-color: var(--accent);
  }
  .segmented {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
    background: var(--surface-2);
    padding: 3px;
    border-radius: var(--r-sm);
  }
  .segmented button {
    padding: 6px 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-muted);
    font-size: 13px;
    text-transform: capitalize;
    cursor: pointer;
  }
  .segmented button.active {
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-1);
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: 13px;
    cursor: pointer;
  }
  .toggle input {
    accent-color: var(--accent);
  }
</style>
