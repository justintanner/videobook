import { describe, expect, it } from 'vitest'
import {
  audioPreviewBadges,
  audioPreviewMeter,
  imagePreviewBadges,
  previewMetadataLabel,
  previewMeter,
  videoPreviewBadges,
} from './cell-preview'
import type { NotebookAudioInfo } from './notebook-cell-presentation'

const stereo: NotebookAudioInfo = {
  channelLayout: 'stereo',
  channels: 2,
  codec: 'aac',
  durationSeconds: 12.5,
  sampleRateHz: 48000,
}

function labels(badges: { label: string }[]): string[] {
  return badges.map((badge) => badge.label)
}

describe('imagePreviewBadges', () => {
  it('names size, shape and generator', () => {
    expect(labels(imagePreviewBadges({
      width: 1024,
      height: 1024,
      tool: 'Generate image',
      model: 'nano-banana',
      provenance: null,
    }))).toEqual(['1024×1024', '1:1', 'Generate image'])
  })

  it('carries frame provenance as its own badge', () => {
    const badges = imagePreviewBadges({
      width: 1920,
      height: 1080,
      tool: null,
      model: null,
      provenance: '@b2 · 0:04',
    })

    expect(labels(badges)).toEqual(['1920×1080', '16:9', '@b2 · 0:04'])
    expect(badges.at(-1)?.title).toBe('Extracted from @b2 · 0:04')
  })

  it('drops what the asset does not know', () => {
    expect(imagePreviewBadges({
      width: null,
      height: null,
      tool: null,
      model: null,
      provenance: null,
    })).toEqual([])
  })
})

describe('videoPreviewBadges', () => {
  it('prefers the cell aspect ratio over one derived from the asset', () => {
    expect(labels(videoPreviewBadges({
      aspectRatio: '9:16',
      width: 1920,
      height: 1080,
      tool: null,
      model: 'veo-3-fast',
      provenance: null,
    }))).toEqual(['9:16', 'veo-3-fast'])
  })

  it('falls back to the asset dimensions', () => {
    expect(labels(videoPreviewBadges({
      aspectRatio: null,
      width: 1920,
      height: 1080,
      tool: null,
      model: null,
      provenance: null,
    }))).toEqual(['16:9'])
  })

  it('leaves duration to the meter', () => {
    const badges = videoPreviewBadges({
      aspectRatio: '16:9',
      width: null,
      height: null,
      tool: null,
      model: null,
      provenance: null,
    })

    expect(badges).toHaveLength(1)
    expect(previewMeter(6)?.label).toBe('0:06')
  })
})

describe('audioPreviewBadges', () => {
  it('leads with the role, then codec, rate and layout', () => {
    expect(labels(audioPreviewBadges({
      audioInfo: stereo,
      durationSeconds: 12.5,
      hasOutput: true,
      inputs: { audioRole: 'scene' },
    }))).toEqual(['Scene audio', 'AAC', '48 kHz', 'stereo'])
  })

  it('still names the role when the asset carries no audio info', () => {
    expect(labels(audioPreviewBadges({
      audioInfo: null,
      durationSeconds: null,
      hasOutput: true,
      inputs: undefined,
    }))).toEqual(['Audio output'])
  })
})

describe('audioPreviewMeter', () => {
  it('times the audio from its own info', () => {
    expect(audioPreviewMeter({
      audioInfo: stereo,
      durationSeconds: null,
      hasOutput: true,
      inputs: undefined,
    })).toEqual({ label: '0:12', seconds: 12.5 })
  })

  it('falls back to a requested range', () => {
    expect(audioPreviewMeter({
      audioInfo: null,
      durationSeconds: null,
      hasOutput: false,
      inputs: { startSeconds: 4, endSeconds: 10 },
    })).toEqual({ label: '0:06', seconds: 6 })
  })

  it('has no meter without a duration', () => {
    expect(audioPreviewMeter({
      audioInfo: null,
      durationSeconds: 0,
      hasOutput: false,
      inputs: undefined,
    })).toBeNull()
  })
})

describe('previewMetadataLabel', () => {
  it('reads the rail, the meter and the prompt as one sentence', () => {
    const badges = videoPreviewBadges({
      aspectRatio: '16:9',
      width: null,
      height: null,
      tool: null,
      model: 'veo-3-fast',
      provenance: null,
    })

    expect(previewMetadataLabel('Video', badges, previewMeter(6), null))
      .toBe('Video metadata. Aspect ratio 16:9. Generator veo-3-fast. Duration 0:06')
  })

  it('appends the prompt when the cell has one', () => {
    expect(previewMetadataLabel('Image', [], null, 'a lighthouse at dusk'))
      .toBe('Image metadata. Prompt: a lighthouse at dusk')
  })
})
