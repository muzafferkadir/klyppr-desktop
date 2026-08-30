export interface Range {
  start: number
  end: number
}

/** Shortest silence span worth cutting, seconds (matches backend MIN_SEGMENT). */
const MIN_KEEP = 0.05

/**
 * Mirror ffmpeg's silencedetect on the pre-computed loudness envelope: find runs
 * of buckets below `thresholdDb` lasting at least `minSilence`, then inset each
 * by `padding` (keeping a little speech around the cut). Pure — the editor calls
 * this live as the user drags the sliders, and the same ranges are sent to the
 * backend at export so preview and output match.
 */
export function computeSilence(
  envelopeDb: number[],
  bucketMs: number,
  thresholdDb: number,
  minSilence: number,
  padding: number,
): Range[] {
  const bucketS = bucketMs / 1000
  const ranges: Range[] = []
  let runStart = -1

  for (let i = 0; i <= envelopeDb.length; i++) {
    const below = i < envelopeDb.length && envelopeDb[i] < thresholdDb
    if (below && runStart < 0) {
      runStart = i
    } else if (!below && runStart >= 0) {
      const start = runStart * bucketS
      const end = i * bucketS
      if (end - start >= minSilence) {
        const ps = start + padding
        const pe = end - padding
        if (pe - ps > MIN_KEEP) ranges.push({ start: ps, end: pe })
      }
      runStart = -1
    }
  }
  return ranges
}

/** Total seconds removed by a set of ranges. */
export function totalCut(ranges: Range[]): number {
  return ranges.reduce((sum, r) => sum + (r.end - r.start), 0)
}
