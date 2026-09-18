import { describe, expect, it } from 'vitest'
import {
  mediaDockAspect,
  mediaDockFacts,
  mediaDockKind,
  mediaDockKindLabel,
} from './media-dock'
import type { MediaDockAsset, MediaDockFact } from './media-dock'
import type { NotebookAudioInfo } from './notebook-cell-presentation'

const stereo: NotebookAudioInfo = {
  channelLayout: 'stereo',
  channels: 2,
  codec: 'aac',
  durationSeconds: 92.5,
  sampleRateHz: 48000,
}

const blankAsset: MediaDockAsset = {
  width: null,
  height: null,
  duration: null,
  audioInfo: null,
}

function terms(facts: MediaDockFact[]): string[] {
  return facts.map((entry) => entry.term)
}

function values(facts: MediaDockFact[]): string[] {
  return facts.map((entry) => entry.value)
}

describe('mediaDockKind', () => {
  it('claims the three cell types that draw a preview', () => {
    expect(mediaDockKind('image')).toBe('image')
    expect(mediaDockKind('video')).toBe('video')
    expect(mediaDockKind('audio')).toBe('audio')
  })

  it('leaves every other cell type to the form inspector', () => {
    expect(mediaDockKind('analysis')).toBeNull()
    expect(mediaDockKind('prompt')).toBeNull()
    expect(mediaDockKind('generate_video')).toBeNull()
  })
})

describe('mediaDockKindLabel', () => {
  it('names the kind the way its version list reads', () => {
    expect(mediaDockKindLabel('image')).toBe('Image')
    expect(mediaDockKindLabel('video')).toBe('Video')
    expect(mediaDockKindLabel('audio')).toBe('Audio')
  })
})

describe('mediaDockAspect', () => {
  it('takes the shape the asset carries for a picture or a clip', () => {
    expect(mediaDockAspect('image', {
      ...blankAsset,
      width: 480,
      height: 854,
    })).toBeCloseTo(480 / 854, 5)
    expect(mediaDockAspect('video', {
      ...blankAsset,
      width: 1920,
      height: 1080,
    })).toBeCloseTo(16 / 9, 5)
  })

  it('falls back to portrait for a picture and wide for a clip', () => {
    expect(mediaDockAspect('image', blankAsset)).toBeCloseTo(9 / 16, 5)
    expect(mediaDockAspect('video', blankAsset)).toBeCloseTo(16 / 9, 5)
    expect(mediaDockAspect('image', null)).toBeCloseTo(9 / 16, 5)
  })

  it('ignores a stray frame size on audio, which has no frame', () => {
    expect(mediaDockAspect('audio', {
      ...blankAsset,
      width: 480,
      height: 854,
    })).toBeCloseTo(16 / 9, 5)
  })

  it('refuses a degenerate frame', () => {
    expect(mediaDockAspect('video', {
      ...blankAsset,
      width: 0,
      height: 1080,
    })).toBeCloseTo(16 / 9, 5)
  })
})

describe('mediaDockFacts', () => {
  it('gives a picture its address, size and shape', () => {
    const facts = mediaDockFacts('image', 'g5', {
      ...blankAsset,
      width: 480,
      height: 854,
    }, undefined)

    expect(terms(facts)).toEqual(['Address', 'Dimensions', 'Aspect'])
    expect(values(facts)).toEqual(['@g5', '480 × 854', '9:16'])
    expect(facts[0]?.emphasis).toBe('address')
    expect(facts[1]?.emphasis).toBe('plain')
  })

  it('adds the run time for a clip', () => {
    const facts = mediaDockFacts('video', 'e1', {
      ...blankAsset,
      width: 720,
      height: 1280,
      duration: 29.02,
    }, undefined)

    expect(terms(facts)).toEqual(['Address', 'Dimensions', 'Aspect', 'Duration'])
    expect(values(facts).at(-1)).toBe('0:29.02')
  })

  it('reads audio as role, run time and format', () => {
    const facts = mediaDockFacts('audio', 'd2', {
      ...blankAsset,
      duration: 92.5,
      audioInfo: stereo,
    }, undefined)

    expect(terms(facts)).toEqual(['Address', 'Role', 'Duration', 'Format'])
    expect(values(facts)).toEqual([
      '@d2',
      'Audio output',
      '1:32.50',
      'AAC · 48 kHz · stereo',
    ])
  })

  it('takes the audio role the cell was configured with', () => {
    const facts = mediaDockFacts('audio', 'd2', {
      ...blankAsset,
      duration: 92.5,
      audioInfo: stereo,
    }, { audioRole: 'continuous-source' })

    expect(values(facts)[1]).toBe('Continuous source')
  })

  it('drops what the asset does not know, keeping the address', () => {
    expect(mediaDockFacts('image', 'a1', blankAsset, undefined))
      .toEqual([{
        key: 'address',
        term: 'Address',
        value: '@a1',
        emphasis: 'address',
      }])
    expect(terms(mediaDockFacts('audio', 'a1', blankAsset, undefined)))
      .toEqual(['Address', 'Role'])
  })
})
