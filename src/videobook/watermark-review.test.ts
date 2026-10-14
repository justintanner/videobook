import { describe, expect, it } from 'vitest'
import {
  clampWatermarkFadeSeconds,
  watermarkFadeWindow,
  watermarkPreviewOpacity,
} from './watermark-review'
import { resolveWatermarkReviewInputs } from './watermark-review-preferences'

describe('remembered watermark review inputs', () => {
  it('retains both aliases while explicit routed inputs override remembered settings', () => {
    expect(resolveWatermarkReviewInputs({
      platform: 'tiktok',
      handles: { x: 'x_alias', tiktok: 'tiktok.alias' },
      includeHandle: true,
      handleStartSeconds: 2,
      handleEndSeconds: 8,
      handleOpacity: 0.7,
    }, {
      platform: 'x',
      handle: 'requested_alias',
      includeHandle: false,
      handleStartSeconds: 0,
      handleEndSeconds: null,
    }, 12)).toMatchObject({
      platform: 'x',
      handles: { x: 'requested_alias', tiktok: 'tiktok.alias' },
      includeHandle: false,
      handleStartSeconds: 0,
      handleEndSeconds: null,
      handleOpacity: 0.7,
    })
  })

  it('fits remembered timings to a shorter clip without creating an empty window', () => {
    expect(resolveWatermarkReviewInputs({
      qrStartSeconds: 1,
      qrEndSeconds: 8,
      handleStartSeconds: 6,
      handleEndSeconds: 10,
    }, {}, 3)).toMatchObject({
      qrStartSeconds: 1,
      qrEndSeconds: 3,
      handleStartSeconds: 0,
      handleEndSeconds: null,
    })
  })

  it('keeps explicit timing, blank aliases and a whole-clip end without fallback', () => {
    expect(resolveWatermarkReviewInputs({
      platform: 'tiktok',
      handles: { tiktok: '' },
      handleStartSeconds: 0,
      handleEndSeconds: null,
    }, { handleStartSeconds: 2, handleEndSeconds: 4 }, null)).toMatchObject({
      platform: 'tiktok',
      handles: { tiktok: '' },
      handleStartSeconds: 2,
      handleEndSeconds: 4,
    })
  })
})

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
    const short = watermarkFadeWindow(2, 2.6, 10, 0.5)
    expect(short.fadeIn).toBeCloseTo(0.3, 10)
    expect(short.fadeOut).toBeCloseTo(0.3, 10)
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
