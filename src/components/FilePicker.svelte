<script lang="ts">
  import { open } from '@tauri-apps/plugin-dialog'

  let { inputPath = $bindable(), outputDir = $bindable() }: {
    inputPath: string
    outputDir: string
  } = $props()

  const basename = (p: string) => p.split(/[\\/]/).pop() ?? p

  async function pickInput() {
    const f = await open({
      multiple: false,
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v'] }],
    })
    if (typeof f === 'string') inputPath = f
  }

  async function pickOutput() {
    const d = await open({ directory: true })
    if (typeof d === 'string') outputDir = d
  }
</script>

<div class="pickers">
  <button class="picker" onclick={pickInput}>
    <span class="label">Input video</span>
    <span class="value" class:empty={!inputPath}>{inputPath ? basename(inputPath) : 'Choose a file…'}</span>
  </button>
  <button class="picker" onclick={pickOutput}>
    <span class="label">Output folder</span>
    <span class="value" class:empty={!outputDir}>{outputDir ? basename(outputDir) : 'Choose a folder…'}</span>
  </button>
</div>

<style>
  .pickers {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-3);
  }
  .picker {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: var(--sp-3) var(--sp-4);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-1);
    cursor: pointer;
    text-align: left;
    transition: border-color 0.15s;
  }
  .picker:hover {
    border-color: var(--accent);
  }
  .label {
    font-size: 12px;
    color: var(--text-muted);
  }
  .value {
    font-size: 14px;
    font-weight: 500;
    color: var(--text);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .value.empty {
    color: var(--text-faint);
    font-weight: 400;
  }
</style>
