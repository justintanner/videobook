import { describe, expect, it } from 'vitest'
import {
  isTranscribeLanguageCode,
  resolveTranscribeTarget,
  transcribeClipChoices,
  transcribeEstimateView,
  transcribeLanguageOverride,
  transcribeRequestOutcome,
  transcribeToolArgs,
  transcribeValidation,
  type TranscribeAssetRef,
} from '../../src/videobook/transcribe-review'

const video: TranscribeAssetRef = {
  artifactId: 'vid-1',
  type: 'video',
  label: 'Interview',
  mediaUrl: '/files/vid-1/proxy.mp4',
  thumbnailUrl: null,
  duration: 12,
}
const audio: TranscribeAssetRef = {
  artifactId: 'aud-1',
  type: 'audio',
  label: 'Voiceover',
  mediaUrl: '/files/aud-1/audio.mp3',
  thumbnailUrl: null,
  duration: 8,
}
const image: TranscribeAssetRef = {
  artifactId: 'img-1',
  type: 'image',
  label: 'Still',
  mediaUrl: null,
  thumbnailUrl: '/files/img-1/original.jpg',
  duration: null,
}
const addresses = new Map([['vid-1', 'a1'], ['aud-1', 'a2'], ['img-1', 'a3']])

describe('transcribe review target', () => {
  it('uses the selected spoken clip when the command names nothing', () => {
    expect(resolveTranscribeTarget({
      selectedCell: { outputArtifactId: 'vid-1', type: 'video' },
      preview: { assetId: 'aud-1', type: 'audio' },
      assets: [video, audio, image],
      addressByArtifactId: addresses,
    })).toEqual({ ok: true, assetId: 'vid-1' })
  })

  it('uses the open preview when the selection cannot be transcribed', () => {
    expect(resolveTranscribeTarget({
      selectedCell: { outputArtifactId: 'img-1', type: 'image' },
      preview: { assetId: 'aud-1', type: 'audio' },
      assets: [video, audio, image],
      addressByArtifactId: addresses,
    })).toEqual({ ok: true, assetId: 'aud-1' })
  })

  it('opens an empty review when nothing spoken is selected', () => {
    expect(resolveTranscribeTarget({
      selectedCell: null,
      preview: null,
      assets: [image],
      addressByArtifactId: addresses,
    })).toEqual({ ok: true, assetId: null })
  })

  it('rejects a bad explicit reference instead of falling back', () => {
    expect(resolveTranscribeTarget({
      assetRef: '@missing',
      selectedCell: { outputArtifactId: 'vid-1', type: 'video' },
      preview: null,
      assets: [video],
      addressByArtifactId: addresses,
    })).toEqual({ ok: false, message: 'No asset found for @missing' })
  })

  it('rejects an explicit clip that has no speech', () => {
    expect(resolveTranscribeTarget({
      assetRef: '@a3',
      selectedCell: { outputArtifactId: 'vid-1', type: 'video' },
      preview: null,
      assets: [video, image],
      addressByArtifactId: addresses,
    })).toEqual({
      ok: false,
      message: 'Transcribe applies to video or audio; @a3 is image',
    })
  })

  it('resolves a grid address and an artifact id', () => {
    expect(resolveTranscribeTarget({
      assetRef: '@a2',
      selectedCell: null,
      preview: null,
      assets: [video, audio],
      addressByArtifactId: addresses,
    })).toEqual({ ok: true, assetId: 'aud-1' })
    expect(resolveTranscribeTarget({
      assetRef: 'vid-1',
      selectedCell: null,
      preview: null,
      assets: [video, audio],
      addressByArtifactId: addresses,
    })).toEqual({ ok: true, assetId: 'vid-1' })
  })

  it('lists spoken clips with grid labels', () => {
    expect(transcribeClipChoices([image, audio, video], addresses).map((clip) => clip.label))
      .toEqual(['@a1', '@a2'])
  })
})

describe('transcribe review apply', () => {
  it('accepts a language code and rejects a prompt', () => {
    expect(isTranscribeLanguageCode('pt-BR')).toBe(true)
    expect(transcribeLanguageOverride('en')).toEqual({ ok: true, languageCode: 'en' })
    expect(transcribeLanguageOverride('make it louder').ok).toBe(false)
  })

  it('blocks apply until a clip is chosen and the language is a code', () => {
    expect(transcribeValidation({ assetId: null, languageCode: '' }).blocking)
      .toBe('Choose a video or audio clip.')
    expect(transcribeValidation({ assetId: 'vid-1', languageCode: 'english' }).blocking)
      .toMatch(/Language must be a code/)
    expect(transcribeValidation({ assetId: 'vid-1', languageCode: '' })).toEqual({
      blocking: null,
      notice: null,
    })
  })

  it('enqueues the existing transcribe tool without waiting', () => {
    expect(transcribeToolArgs({
      bookId: 'book-1',
      assetId: 'vid-1',
      languageCode: ' en ',
      diarize: false,
      tagAudioEvents: true,
    })).toEqual({
      book_id: 'book-1',
      asset_id: 'vid-1',
      language_code: 'en',
      diarize: false,
      tag_audio_events: true,
      wait: false,
    })
    expect(transcribeToolArgs({
      bookId: 'book-1',
      assetId: 'vid-1',
      languageCode: ' ',
      diarize: true,
      tagAudioEvents: true,
    })).not.toHaveProperty('language_code')
  })

  it('reads a cached transcript or the job that serves the request', () => {
    expect(transcribeRequestOutcome({ status: 'cached', job_id: null })).toEqual({ kind: 'cached' })
    expect(transcribeRequestOutcome({ status: 'running', job_id: 42 })).toEqual({ kind: 'queued', jobId: 42 })
    expect(transcribeRequestOutcome({ status: 'queued' })).toEqual({ kind: 'queued', jobId: null })
    expect(transcribeRequestOutcome(null)).toEqual({ kind: 'queued', jobId: null })
  })

  it('hides an estimate that the server could not price', () => {
    expect(transcribeEstimateView({ usd: 0.012, warnings: [] })).toEqual({
      usd: 0.012,
      unavailable: false,
    })
    expect(transcribeEstimateView({
      usd: 0.01,
      warnings: ['historical average per call'],
    }).unavailable).toBe(false)
    expect(transcribeEstimateView({
      usd: null,
      warnings: ['no cost adapter'],
    })).toEqual({ usd: null, unavailable: true })
  })
})
