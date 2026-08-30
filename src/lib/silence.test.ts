import { describe, it, expect } from 'vitest'
import { computeSilence, totalCut } from './silence'

// 100ms buckets keep the math easy to read.
const B = 100

describe('computeSilence', () => {
  it('finds a below-threshold run past min-silence', () => {
    // buckets: loud, then 5×silent (0.5s), then loud. threshold -30.
    const env = [-10, -50, -50, -50, -50, -50, -10]
    const r = computeSilence(env, B, -30, 0.3, 0)
    expect(r).toHaveLength(1)
    expect(r[0].start).toBeCloseTo(0.1)
    expect(r[0].end).toBeCloseTo(0.6)
  })

  it('drops runs shorter than min-silence', () => {
    const env = [-10, -50, -50, -10] // 0.2s silence
    expect(computeSilence(env, B, -30, 0.3, 0)).toEqual([])
  })

  it('insets by padding and drops what collapses', () => {
    const env = [-10, -50, -50, -50, -50, -50, -10] // 0.5s silence
    const r = computeSilence(env, B, -30, 0.3, 0.05)
    expect(r[0].start).toBeCloseTo(0.15)
    expect(r[0].end).toBeCloseTo(0.55)
  })

  it('handles silence running to the very end', () => {
    const env = [-10, -50, -50, -50, -50] // silence to EOF
    const r = computeSilence(env, B, -30, 0.3, 0)
    expect(r).toHaveLength(1)
    expect(r[0].start).toBeCloseTo(0.1)
    expect(r[0].end).toBeCloseTo(0.5)
  })

  it('totalCut sums removed spans', () => {
    expect(totalCut([{ start: 1, end: 2 }, { start: 5, end: 5.5 }])).toBeCloseTo(1.5)
  })
})
