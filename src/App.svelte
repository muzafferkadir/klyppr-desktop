<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'

  // Temporary skeleton screen: only verifies the ffprobe sidecar is wired up.
  // Replaced by the real UI (FilePicker, settings, progress…) in a later step.
  let result = $state('')
  let busy = $state(false)

  async function testSidecar() {
    busy = true
    result = ''
    try {
      result = await invoke<string>('ffprobe_version')
    } catch (e) {
      result = `ERROR: ${e}`
    } finally {
      busy = false
    }
  }
</script>

<main>
  <h1>Klyppr</h1>
  <p class="sub">Tauri + Svelte skeleton — sidecar smoke test</p>

  <button onclick={testSidecar} disabled={busy}>
    {busy ? 'Running…' : 'Test ffprobe sidecar'}
  </button>

  {#if result}
    <pre class:error={result.startsWith('ERROR')}>{result}</pre>
  {/if}
</main>

<style>
  main {
    max-width: 640px;
    margin: 0 auto;
    padding: 3rem 1.5rem;
    text-align: center;
    font-family: system-ui, -apple-system, sans-serif;
  }
  h1 { margin: 0 0 0.25rem; font-size: 2.5rem; }
  .sub { margin: 0 0 2rem; opacity: 0.6; }
  button {
    padding: 0.7rem 1.4rem;
    font-size: 1rem;
    border-radius: 8px;
    border: 1px solid rgba(128, 128, 128, 0.4);
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  pre {
    margin-top: 1.5rem;
    padding: 1rem;
    text-align: left;
    background: rgba(128, 128, 128, 0.12);
    border-radius: 8px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  pre.error { color: #e5484d; }
</style>
