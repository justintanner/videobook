import { describe, expect, it } from 'vitest'
import {
  overlapDraftValue,
  spliceBestOverlap,
  spliceMatchQuality,
  splicePlan,
  spliceScorePath,
  spliceWindowFraction,
} from './splice-preview'
import { parseSplicePreview, type SplicePreviewMatch } from './use-splice-preview'

const match: SplicePreviewMatch = {
  fps: 10,
  firstDuration: 3,
  secondDuration: 2,
  window: 2,
  windowStartFrame: 10,
  scores: [40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 9, 2, 3, 4, 5, 6, 7, 8, 1.5, 9],
}

describe('splice preview plan', () => {
  it('cuts at the best frame inside the overlap window', () => {
    expect(splicePlan(2, match, 3, 2)).toEqual({
      cut: 2.8,
      frameIndex: 28,
      score: 1.5,
      trimmed: 3 - 2.8,
      total: 4.8,
      quality: 'seamless',
    })
    const narrow = splicePlan(0.15, match, 3, 2)
    expect(narrow?.frameIndex).toBe(28)
    const wider = splicePlan(0.1, match, 3, 2)
    expect(wider?.frameIndex).toBe(29)
    expect(wider?.quality).toBe('visible')
  })

  it('finds the overlap that reaches the closest frame', () => {
    const overlap = spliceBestOverlap(match)
    expect(overlap).toBeCloseTo(0.25, 5)
    expect(splicePlan(overlap!, match, 3, 2)?.frameIndex).toBe(28)
  })

  it('plays both clips whole at zero overlap, even before scores load', () => {
    const plan = splicePlan(0, null, 3, 2)
    expect(plan).toEqual({
      cut: 3,
      frameIndex: null,
      score: null,
      trimmed: 0,
      total: 5,
      quality: null,
    })
    expect(splicePlan(1, null, 3, 2)).toBeNull()
  })

  it('grades frame differences', () => {
    expect(spliceMatchQuality(1)).toBe('seamless')
    expect(spliceMatchQuality(3)).toBe('close')
    expect(spliceMatchQuality(8)).toBe('visible')
    expect(spliceMatchQuality(80)).toBe('hard')
  })

  it('maps window times and draws the score curve', () => {
    expect(spliceWindowFraction(match, 1)).toBe(0)
    expect(spliceWindowFraction(match, 2)).toBe(0.5)
    expect(spliceWindowFraction(match, 3)).toBe(1)
    expect(spliceScorePath([0, 10], 100, 20)).toBe('M0.00 0.00 L100.00 20.00')
    expect(overlapDraftValue(1 / 3)).toBe('0.333')
  })

  it('parses the preview_splice response', () => {
    expect(parseSplicePreview({
      fps: 10,
      first_duration: 3,
      second_duration: 2,
      window: 2,
      window_start_frame: 10,
      scores: [1, 2],
    })).toEqual({
      fps: 10,
      firstDuration: 3,
      secondDuration: 2,
      window: 2,
      windowStartFrame: 10,
      scores: [1, 2],
    })
    expect(parseSplicePreview({ fps: 10, scores: [] })).toBeNull()
  })
})
