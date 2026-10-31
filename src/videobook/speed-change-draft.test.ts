import { describe, expect, it } from 'vitest'
import {
  clampSection,
  lastSecondsSection,
  speedChangeDraftFromParams,
  speedChangeOutcome,
  speedChangeParams,
} from './speed-change-draft'

describe('speed change draft', () => {
  it('reads a routed section plan and computes the shorter result', () => {
    const draft = speedChangeDraftFromParams({ asset_id: 'a', speed: 1.5, start_seconds: 8.38 })
    const outcome = speedChangeOutcome(draft, 14.38)
    expect(outcome.sectionEndSeconds).toBe(14.38)
    expect(outcome.outputSeconds).toBeCloseTo(8.38 + 6 / 1.5, 5)
    expect(outcome.error).toBeNull()
  })

  it('derives the section speed from a target duration', () => {
    const draft = { speed: null, targetSeconds: 11.38, section: { startSeconds: 8.38, endSeconds: 14.38 } }
    const outcome = speedChangeOutcome(draft, 14.38)
    expect(outcome.effectiveSpeed).toBeCloseTo(2, 5)
    expect(outcome.outputSeconds).toBeCloseTo(11.38, 5)
  })

  it('blocks a target the untouched part already exceeds', () => {
    const draft = { speed: null, targetSeconds: 6, section: { startSeconds: 8.38, endSeconds: 14.38 } }
    expect(speedChangeOutcome(draft, 14.38).error).toMatch(/target duration/)
  })

  it('blocks 1x and out-of-range speeds', () => {
    expect(speedChangeOutcome({ speed: 1, targetSeconds: null, section: null }, 10).error).toMatch(/1×/)
    expect(speedChangeOutcome({ speed: null, targetSeconds: 1, section: null }, 10).error).toMatch(/between/)
  })

  it('writes exactly one of speed or target and drops stale section keys', () => {
    const params = { asset_id: 'a', book_id: 'b', speed: 2, start_seconds: 3, end_seconds: 5 }
    expect(speedChangeParams(params, { speed: null, targetSeconds: 7, section: null })).toEqual({
      asset_id: 'a',
      book_id: 'b',
      target_duration_seconds: 7,
    })
    expect(speedChangeParams(params, {
      speed: 1.5,
      targetSeconds: null,
      section: { startSeconds: 4, endSeconds: 9 },
    })).toEqual({ asset_id: 'a', book_id: 'b', speed: 1.5, start_seconds: 4, end_seconds: 9 })
  })

  it('keeps sections inside the clip and at least 0.1s long', () => {
    expect(clampSection({ startSeconds: 9, endSeconds: 9 }, 10)).toEqual({ startSeconds: 8.9, endSeconds: 9 })
    expect(clampSection({ startSeconds: -2, endSeconds: 20 }, 10)).toEqual({ startSeconds: 0, endSeconds: 10 })
    expect(lastSecondsSection(6, 14.38)).toEqual({ startSeconds: 8.38, endSeconds: 14.38 })
  })
})
