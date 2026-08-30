import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type QualityPreset = 'fast' | 'medium' | 'high' | 'lossless'

export interface JobRequest {
  inputPath: string
  outputDir: string
  silenceDb: number
  minSilence: number
  padding: number
  normalizeAudio: boolean
  quality: QualityPreset
  useHardware: boolean
  /** Editor cut ranges (seconds). When set, backend skips its own detection. */
  silenceRanges?: [number, number][]
}

export interface AudioAnalysis {
  duration: number
  bucketMs: number
  peaks: number[]
  envelopeDb: number[]
}

export const analyzeAudio = (inputPath: string) => invoke<AudioAnalysis>('analyze_audio', { inputPath })

/** The user-tunable subset of a job (everything except the paths). */
export type Settings = Omit<JobRequest, 'inputPath' | 'outputDir'>

export type Phase = 'probe' | 'detect' | 'measure' | 'encode' | 'verify'
export type LogLevel = 'info' | 'warn' | 'error'

export interface AppErrorDto {
  kind: string
  message: string
}

export type JobEvent =
  | { kind: 'phase'; jobId: string; phase: Phase }
  | { kind: 'progress'; jobId: string; fraction: number }
  | { kind: 'log'; jobId: string; level: LogLevel; message: string }
  | { kind: 'finished'; jobId: string; outputPath: string }
  | { kind: 'failed'; jobId: string; error: AppErrorDto }
  | { kind: 'cancelled'; jobId: string }

export interface MediaInfo {
  inputExt: string
  duration: number
  video: { pixFmt: string; width: number; height: number } | null
  audios: unknown[]
}

export interface EncoderInfo {
  available: boolean
  name: string
  description: string
}

export const getEncoderInfo = () => invoke<EncoderInfo>('get_encoder_info')
export const startJob = (request: JobRequest) => invoke<string>('start_job', { request })
export const cancelJob = (jobId: string) => invoke<boolean>('cancel_job', { jobId })
export const probeMedia = (inputPath: string) => invoke<MediaInfo>('probe_media', { inputPath })
export const ffprobeVersion = () => invoke<string>('ffprobe_version')

/** Subscribe to backend job events. Returns an unlisten function. */
export const onJobEvent = (cb: (e: JobEvent) => void): Promise<UnlistenFn> =>
  listen<JobEvent>('job-event', (ev) => cb(ev.payload))
