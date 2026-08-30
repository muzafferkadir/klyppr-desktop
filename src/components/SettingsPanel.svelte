<script lang="ts">
  import type { EncoderInfo, QualityPreset } from '../lib/tauri'

  let {
    silenceDb = $bindable(),
    minSilence = $bindable(),
    padding = $bindable(),
    quality = $bindable(),
    normalizeAudio = $bindable(),
    useHardware = $bindable(),
    encoder,
    disabled = false,
  }: {
    silenceDb: number
    minSilence: number
    padding: number
    quality: QualityPreset
    normalizeAudio: boolean
    useHardware: boolean
    encoder: EncoderInfo
    disabled?: boolean
  } = $props()

  const presets = {
    recommended: { silenceDb: -40, minSilence: 0.2, padding: 0.06 },
    fast: { silenceDb: -30, minSilence: 0.4, padding: 0.035 },
  }
  let activePreset = $state<'recommended' | 'fast' | null>(null)

  function applyPreset(name: 'recommended' | 'fast') {
    activePreset = name
    silenceDb = presets[name].silenceDb
    minSilence = presets[name].minSilence
    padding = presets[name].padding
  }
</script>

<section class="card presets-section">
  <h3 class="section-title">
    <svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
    Quick Presets
  </h3>
  <div class="button-group">
    <button class="preset-btn" class:active={activePreset === 'recommended'} onclick={() => applyPreset('recommended')} {disabled} data-tooltip="Balanced quality and speed">
      <span class="preset-name">Recommended</span>
      <span class="preset-desc">Balanced quality</span>
    </button>
    <button class="preset-btn" class:active={activePreset === 'fast'} onclick={() => applyPreset('fast')} {disabled} data-tooltip="Faster processing, more aggressive">
      <span class="preset-name">Aggressive</span>
      <span class="preset-desc">Tight detection</span>
    </button>
  </div>
</section>

<section class="card settings-section">
  <h3 class="section-title">
    <svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15a3 3 0 100-6 3 3 0 000 6z" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" /></svg>
    Advanced Settings
  </h3>
  <div class="settings-group visible">
    <div class="settings-grid">
      <div class="form-group">
        <label class="form-label" for="silenceDb" data-tooltip="Lower values = more sensitive">Silence Threshold <span class="unit">dB</span></label>
        <input id="silenceDb" type="number" bind:value={silenceDb} step="1" class="number-input" {disabled} />
      </div>
      <div class="form-group">
        <label class="form-label" for="minSilence" data-tooltip="Minimum silence duration to detect">Min. Silence <span class="unit">sec</span></label>
        <input id="minSilence" type="number" bind:value={minSilence} step="0.1" min="0" class="number-input" {disabled} />
      </div>
      <div class="form-group">
        <label class="form-label" for="padding" data-tooltip="Keep this much audio before/after silence">Padding <span class="unit">sec</span></label>
        <input id="padding" type="number" bind:value={padding} step="0.01" min="0" class="number-input" {disabled} />
      </div>
      <div class="form-group form-group-wide">
        <label class="form-label" for="quality" data-tooltip="Higher quality = slower processing">Video Quality</label>
        <select id="quality" bind:value={quality} class="select-input" {disabled}>
          <option value="lossless">Lossless (No Quality Loss, Largest File)</option>
          <option value="high">High (Best Quality, Slower)</option>
          <option value="medium">Medium (Balanced)</option>
          <option value="fast">Fast (Lower Quality, Faster)</option>
        </select>
      </div>
    </div>

    <div class="checkbox-group">
      <label class="checkbox-label" for="normalizeAudio" data-tooltip="Normalize audio to YouTube standards">
        <span class="checkbox-text">
          <span class="checkbox-title">
            <svg class="checkbox-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 7H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" /></svg>
            Normalize Audio (YouTube Standard)
          </span>
          <span class="checkbox-desc">Adjust volume to -16 LUFS (MrBeast/YouTube level)</span>
        </span>
        <input id="normalizeAudio" type="checkbox" bind:checked={normalizeAudio} class="checkbox-input" {disabled} />
      </label>

      {#if encoder.available}
        <label class="checkbox-label" for="useHardware" data-tooltip="Use GPU for faster video encoding">
          <span class="checkbox-text">
            <span class="checkbox-title">
              <svg class="checkbox-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" /><line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" /><line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" /><line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" /></svg>
              GPU Acceleration ({encoder.name})
            </span>
            <span class="checkbox-desc">{encoder.description}</span>
          </span>
          <input id="useHardware" type="checkbox" bind:checked={useHardware} class="checkbox-input" {disabled} />
        </label>
      {/if}
    </div>
  </div>
</section>
