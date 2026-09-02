import { describe, expect, it } from 'vitest'
import {
  clampWatermarkFadeSeconds,
  watermarkFadeWindow,
  watermarkPreviewOpacity,
} from './watermark-review'

describe('watermarkFadeWindow', () => {
  it('leaves a whole-clip watermark with hard edges', () => {
    expect(watermarkFadeWindow(0, null, 10, 0.5)).toEqual({ fadeIn: 0, fadeOut: 0 })
    expect(watermarkFadeWindow(0, 10, 10, 0.5)).toEqual({ fadeIn: 0, fadeOut: 0 })
  })

  it('fades only at edges inside the clip', () => {
    expect(watermarkFadeWindow(2, 6, 10, 0.5)).toEqual({ fadeIn: 0.5, fadeOut: 0.5 })
    expect(watermarkFadeWindow(0, 6, 10, 0.5)).toEqual({ fadeIn: 0, fadeOut: 0.5 })
    expect(watermarkFadeWindow(2, null, 10, 0.5)).toEqual({ fadeIn: 0.5, fadeOut: 0 })
  })

  it('shrinks fades to half of a short window and honours fade off', () => {
    expect(watermarkFadeWindow(2, 2.6, 10, 0.5)).toEqual({ fadeIn: 0.3, fadeOut: 0.3 })
    expect(watermarkFadeWindow(2, 6, 10, 0)).toEqual({ fadeIn: 0, fadeOut: 0 })
  })
})

describe('watermarkPreviewOpacity', () => {
  it('hides the watermark outside its window', () => {
    expect(watermarkPreviewOpacity(1, 2, 6, 10, 0.5, 0.5)).toBe(0)
    expect(watermarkPreviewOpacity(7, 2, 6, 10, 0.5, 0.5)).toBe(0)
  })

  it('ramps through the fades and holds the set opacity between them', () => {
    expect(watermarkPreviewOpacity(2.25, 2, 6, 10, 0.5, 0.5)).toBeCloseTo(0.25, 5)
    expect(watermarkPreviewOpacity(4, 2, 6, 10, 0.5, 0.5)).toBe(0.5)
    expect(watermarkPreviewOpacity(5.9, 2, 6, 10, 0.5, 0.5)).toBeCloseTo(0.1, 5)
  })

  it('keeps a whole-clip watermark at full strength from the first frame', () => {
    expect(watermarkPreviewOpacity(0, 0, null, 10, 0.8, 0.5)).toBe(0.8)
    expect(watermarkPreviewOpacity(0, 0, null, 0, 0.8, 0.5)).toBe(0.8)
  })
})

describe('clampWatermarkFadeSeconds', () => {
  it('clamps to the supported range in tenths', () => {
    expect(clampWatermarkFadeSeconds(Number.NaN)).toBe(0.5)
    expect(clampWatermarkFadeSeconds(-1)).toBe(0)
    expect(clampWatermarkFadeSeconds(9)).toBe(2)
    expect(clampWatermarkFadeSeconds(0.74)).toBe(0.7)
  })
})
