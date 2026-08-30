import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// @tauri-apps/cli sets TAURI_ENV_* during `tauri dev`/`build`.
const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],

  // Tauri expects a fixed dev port and doesn't handle Vite's HMR websocket
  // discovery, so pin the port and disable the error overlay noise.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: {
      // don't watch the Rust backend from the frontend dev server
      ignored: ['**/src-tauri/**'],
    },
  },
})
