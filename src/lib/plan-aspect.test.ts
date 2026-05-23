import { describe, expect, it } from 'vitest'
import {
  falWanImageSizeForDimensions,
  kieImageAspectRatioForDimensions,
  seedanceAspectRatioForDimensions,
  sourceAspectFromDimensions,
} from './plan-aspect'

describe('plan aspect helpers', () => {
  it('maps landscape metadata to 16:9 fields', () => {
    expect(seedanceAspectRatioForDimensions(1920, 1080)).toBe('16:9')
    expect(kieImageAspectRatioForDimensions('nano-banana-pro', 1920, 1080)).toBe('16:9')
    expect(falWanImageSizeForDimensions(1920, 1080)).toBe('landscape_16_9')
  })

  it('maps portrait metadata to 9:16 fields', () => {
    expect(seedanceAspectRatioForDimensions(1080, 1920)).toBe('9:16')
    expect(kieImageAspectRatioForDimensions('gpt-image-2', 1080, 1920)).toBe('9:16')
    expect(falWanImageSizeForDimensions(1080, 1920)).toBe('portrait_16_9')
  })

  it('maps square metadata to square fields', () => {
    expect(seedanceAspectRatioForDimensions(1000, 1000)).toBe('1:1')
    expect(kieImageAspectRatioForDimensions('wan-2-7-image-pro', 1000, 1000)).toBe('1:1')
    expect(falWanImageSizeForDimensions(1000, 1000)).toBe('square')
  })

  it('maps ultrawide metadata to the closest supported fields', () => {
    expect(seedanceAspectRatioForDimensions(2560, 1080)).toBe('21:9')
    expect(kieImageAspectRatioForDimensions('nano-banana-pro', 2560, 1080)).toBe('21:9')
    expect(kieImageAspectRatioForDimensions('gpt-image-2', 2560, 1080)).toBe('16:9')
    expect(falWanImageSizeForDimensions(2560, 1080)).toBe('landscape_16_9')
  })

  it('maps 4:3 metadata to 4:3 fields', () => {
    expect(seedanceAspectRatioForDimensions(1440, 1080)).toBe('4:3')
    expect(kieImageAspectRatioForDimensions('nano-banana-pro', 1440, 1080)).toBe('4:3')
    expect(falWanImageSizeForDimensions(1440, 1080)).toBe('landscape_4_3')
  })

  it('maps 3:4 metadata to 3:4 fields', () => {
    expect(seedanceAspectRatioForDimensions(1080, 1440)).toBe('3:4')
    expect(kieImageAspectRatioForDimensions('nano-banana-pro', 1080, 1440)).toBe('3:4')
    expect(falWanImageSizeForDimensions(1080, 1440)).toBe('portrait_4_3')
  })

  it('falls back to the old 16:9 behavior when metadata is missing', () => {
    const sourceAspect = sourceAspectFromDimensions(null, undefined)
    expect(sourceAspect).toMatchObject({ width: null, height: null, ratio: 16 / 9, css: '16 / 9', hasMetadata: false })
    expect(seedanceAspectRatioForDimensions(null, undefined)).toBe('16:9')
    expect(kieImageAspectRatioForDimensions('nano-banana-pro', null, undefined)).toBe('16:9')
    expect(falWanImageSizeForDimensions(null, undefined)).toBe('landscape_16_9')
  })

  it('uses adaptive Seedance for non-native source ratios', () => {
    expect(seedanceAspectRatioForDimensions(1500, 1000)).toBe('adaptive')
  })
})
