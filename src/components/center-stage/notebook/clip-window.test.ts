import { describe, expect, it } from 'vitest'
import {
  CLIP_PRECISION,
  clampClip,
  clipWindowPayload,
  displayClipWindow,
  isClipUnset,
  normalizeClipWindow,
  roundClip,
  sharedFiniteBounds,
  withEffectiveClipWindow,
} from './clip-window'

const GOOGLE_OMNI_BOUNDS = { min: 0, max: 10 }

describe('sharedFiniteBounds', () => {
  it('returns intersection when both schemas have finite min/max', () => {
    expect(sharedFiniteBounds(
      { minimum: 0, maximum: 10 },
      { minimum: 0, maximum: 10 },
    )).toEqual({ min: 0, max: 10 })
  })

  it('returns null when either side lacks finite bounds', () => {
    expect(sharedFiniteBounds({ minimum: 0 }, { minimum: 0, maximum: 10 })).toBeNull()
    expect(sharedFiniteBounds({ minimum: 0, maximum: 10 }, { maximum: 10 })).toBeNull()
    expect(sharedFiniteBounds(undefined, { minimum: 0, maximum: 10 })).toBeNull()
  })

  it('returns null when intersection is empty', () => {
    expect(sharedFiniteBounds(
      { minimum: 0, maximum: 2 },
      { minimum: 5, maximum: 10 },
    )).toBeNull()
  })
})

describe('roundClip / clampClip', () => {
  it('rounds to 0.01 precision', () => {
    expect(roundClip(1.234)).toBeCloseTo(1.23, 5)
    expect(roundClip(1.235)).toBeCloseTo(1.24, 5)
    expect(CLIP_PRECISION).toBe(0.01)
  })

  it('clamps into bounds then rounds', () => {
    expect(clampClip(-1, GOOGLE_OMNI_BOUNDS)).toBe(0)
    expect(clampClip(12, GOOGLE_OMNI_BOUNDS)).toBe(10)
    expect(clampClip(3.456, GOOGLE_OMNI_BOUNDS)).toBeCloseTo(3.46, 5)
  })
})

describe('normalizeClipWindow', () => {
  it('clamps start and ends to schema bounds', () => {
    expect(normalizeClipWindow(-2, 15, GOOGLE_OMNI_BOUNDS)).toEqual({ start: 0, ends: 10 })
  })

  it('enforces start strictly less than end', () => {
    const crossed = normalizeClipWindow(5, 5, GOOGLE_OMNI_BOUNDS)
    expect(crossed.start).toBeLessThan(crossed.ends)
    expect(crossed.ends - crossed.start).toBeCloseTo(CLIP_PRECISION, 5)

    const inverted = normalizeClipWindow(8, 2, GOOGLE_OMNI_BOUNDS)
    expect(inverted.start).toBeLessThan(inverted.ends)
  })

  it('keeps 0.01 precision on both handles', () => {
    const result = normalizeClipWindow(1.111, 4.999, GOOGLE_OMNI_BOUNDS)
    expect(result.start).toBeCloseTo(1.11, 5)
    expect(result.ends).toBeCloseTo(5, 5)
  })
})

describe('displayClipWindow / isClipUnset / clipWindowPayload', () => {
  it('shows full range when unset without treating values as persisted', () => {
    expect(isClipUnset(undefined, undefined)).toBe(true)
    expect(isClipUnset(null, null)).toBe(true)
    expect(isClipUnset(0, undefined)).toBe(false)
    const display = displayClipWindow(undefined, undefined, GOOGLE_OMNI_BOUNDS)
    expect(display).toEqual({ start: 0, ends: 10, unset: true })
  })

  it('normalizes set values for display', () => {
    const display = displayClipWindow(2, 6, GOOGLE_OMNI_BOUNDS)
    expect(display.unset).toBe(false)
    expect(display.start).toBe(2)
    expect(display.ends).toBe(6)
  })

  it('writes both original payload keys on interaction shape', () => {
    expect(clipWindowPayload(1.5, 7.25)).toEqual({
      video_clip_start: 1.5,
      video_clip_ends: 7.25,
    })
  })
})

describe('withEffectiveClipWindow', () => {
  it('fills full bounds when clip is unset so v2v tool-call includes start/ends', () => {
    const out = withEffectiveClipWindow(
      { prompt: 'hyper realistic', video_slug: '@vid-clip' },
      GOOGLE_OMNI_BOUNDS,
    )
    expect(out).toEqual({
      prompt: 'hyper realistic',
      video_slug: '@vid-clip',
      video_clip_start: 0,
      video_clip_ends: 10,
    })
  })

  it('preserves and normalizes an explicit window', () => {
    const out = withEffectiveClipWindow(
      { video_slug: '@vid-clip', video_clip_start: 2.004, video_clip_ends: 7.996 },
      GOOGLE_OMNI_BOUNDS,
    )
    expect(out.video_clip_start).toBe(2)
    expect(out.video_clip_ends).toBe(8)
  })

  it('is a no-op without dual-range bounds', () => {
    const values = { video_slug: '@vid-clip' }
    expect(withEffectiveClipWindow(values, null)).toBe(values)
  })
})
