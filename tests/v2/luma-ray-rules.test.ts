import { describe, expect, it } from 'vitest'
import { previewGeneration } from '../../server/src/media/preview.js'

const IMAGE_TO_VIDEO = 'fal:luma/agent/ray/v3.2/image-to-video'
const VIDEO_TO_VIDEO = 'fal:luma/agent/ray/v3.2/video-to-video'
const url = (name: string) => `https://example.com/${name}.png`
const error = (input: Parameters<typeof previewGeneration>[0]) => {
  const result = previewGeneration(input)
  return result.ok ? null : result.error
}

describe('Luma Ray 3.2 input rules', () => {
  it('refuses a loop with an end frame or HDR, and keyframes with frames or a loop', () => {
    expect(error({ model: IMAGE_TO_VIDEO, prompt: 'x', refs: { first_frame: [url('a')], last_frame: [url('b')] }, options: { loop: true } }))
      .toBe('Loop: can\'t loop with an end frame')
    expect(error({ model: IMAGE_TO_VIDEO, prompt: 'x', refs: { first_frame: [url('a')] }, options: { loop: true, hdr: true, resolution: '1080p' } }))
      .toContain('can\'t loop an HDR generation')
    expect(error({ model: IMAGE_TO_VIDEO, prompt: 'x', refs: { first_frame: [url('a')] }, options: { keyframes: [url('k')], keyframe_indexes: [0] } }))
      .toBe('Image url: can\'t be combined with keyframes')
    expect(error({ model: VIDEO_TO_VIDEO, prompt: 'x', refs: { video: ['https://example.com/v.mp4'], first_frame: [url('a')] }, options: { keyframes: [url('k')], keyframe_indexes: [0] } }))
      .toContain('can\'t be combined with keyframes')
  })

  it('needs one unique, non-negative index per keyframe', () => {
    expect(error({ model: IMAGE_TO_VIDEO, prompt: 'x', options: { keyframes: [url('k'), url('l')], keyframe_indexes: [0] } }))
      .toBe('Keyframe indexes: give one keyframe index per keyframe')
    expect(error({ model: IMAGE_TO_VIDEO, prompt: 'x', options: { keyframes: [url('k'), url('l')], keyframe_indexes: [4, 4] } }))
      .toBe('Keyframe indexes: keyframe indexes must be unique and non-negative')
    expect(error({ model: IMAGE_TO_VIDEO, prompt: 'x', options: { keyframes: [url('k'), url('l')], keyframe_indexes: [0, 100] } })).toBeNull()
    expect(error({ model: IMAGE_TO_VIDEO, prompt: 'x', refs: { first_frame: [url('a')] }, options: { loop: true } })).toBeNull()
  })
})
