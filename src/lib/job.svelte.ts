import {
  cancelJob,
  onJobEvent,
  startJob,
  type JobEvent,
  type JobRequest,
  type LogLevel,
  type Phase,
} from './tauri'
import type { UnlistenFn } from '@tauri-apps/api/event'

export interface LogLine {
  level: LogLevel
  message: string
}

export type JobResult =
  | { ok: true; outputPath: string }
  | { ok: false; cancelled?: boolean; error?: string }

const MAX_LOGS = 500

export const job = $state({
  running: false,
  phase: null as Phase | null,
  progress: 0,
  logs: [] as LogLine[],
  result: null as JobResult | null,
  currentId: null as string | null,
})

let unlisten: Promise<UnlistenFn> | null = null

/** Wire the single global job-event listener. Idempotent. */
export function initJobEvents() {
  if (!unlisten) unlisten = onJobEvent(handle)
}

function handle(e: JobEvent) {
  // Ignore stray events from a previous job.
  if (e.jobId !== job.currentId) return
  switch (e.kind) {
    case 'phase':
      job.phase = e.phase
      break
    case 'progress':
      job.progress = e.fraction
      break
    case 'log':
      job.logs.push({ level: e.level, message: e.message })
      if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS)
      break
    case 'finished':
      job.running = false
      job.progress = 1
      job.result = { ok: true, outputPath: e.outputPath }
      break
    case 'failed':
      job.running = false
      job.result = { ok: false, error: e.error.message }
      break
    case 'cancelled':
      job.running = false
      job.result = { ok: false, cancelled: true }
      break
  }
}

export async function run(request: JobRequest) {
  initJobEvents()
  job.running = true
  job.phase = null
  job.progress = 0
  job.logs = []
  job.result = null
  job.currentId = null
  try {
    job.currentId = await startJob(request)
  } catch (err) {
    job.running = false
    const message = err && typeof err === 'object' && 'message' in err ? String((err as any).message) : String(err)
    job.result = { ok: false, error: message }
  }
}

export async function cancel() {
  if (job.currentId) await cancelJob(job.currentId)
}
