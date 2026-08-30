<script lang="ts">
  import { onMount } from 'svelte'
  import { check, type Update } from '@tauri-apps/plugin-updater'
  import { relaunch } from '@tauri-apps/plugin-process'

  let update = $state<Update | null>(null)
  let busy = $state(false)
  let dismissed = $state(false)
  let error = $state('')

  onMount(async () => {
    // Silent on failure: offline, or no release published yet.
    try {
      const u = await check()
      if (u?.available) update = u
    } catch {
      /* ignore */
    }
  })

  async function install() {
    if (!update) return
    busy = true
    error = ''
    try {
      await update.downloadAndInstall()
      await relaunch()
    } catch (e) {
      busy = false
      error = e && typeof e === 'object' && 'message' in e ? String((e as any).message) : String(e)
    }
  }
</script>

{#if update && !dismissed}
  <div class="banner">
    <span class="text">
      {#if error}
        Update failed: {error}
      {:else}
        Version {update.version} is available.
      {/if}
    </span>
    <div class="actions">
      <button class="update" onclick={install} disabled={busy}>
        {busy ? 'Updating…' : 'Update'}
      </button>
      <button class="dismiss" onclick={() => (dismissed = true)} disabled={busy} aria-label="Dismiss">×</button>
    </div>
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-4);
    background: var(--accent);
    color: var(--accent-contrast);
    border-radius: var(--r-md);
    font-size: 13px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .update {
    padding: 5px 12px;
    border: none;
    border-radius: var(--r-sm);
    background: var(--accent-contrast);
    color: var(--accent);
    font-weight: 600;
    font-size: 12px;
    cursor: pointer;
  }
  .update:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .dismiss {
    border: none;
    background: transparent;
    color: var(--accent-contrast);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.85;
  }
</style>
