import { describe, expect, it } from 'vitest'
import {
  asMediaTranscript,
  asMediaVisionAnalysis,
  transcriptDetailLabel,
  transcriptHasText,
  visionAnalysisDetailLabel,
} from './media-insights'

describe('asMediaTranscript', () => {
  it('decodes a timed transcript payload', () => {
    expect(asMediaTranscript({
      kind: 'timed',
      language_code: 'eng',
      text: 'Hello world',
      word_count: 2,
    })).toEqual({
      kind: 'timed',
      languageCode: 'eng',
      text: 'Hello world',
      wordCount: 2,
    })
  })

  it('decodes a silence marker with no text', () => {
    expect(asMediaTranscript({
      kind: 'silence',
      language_code: null,
      text: '',
      word_count: 0,
    })).toEqual({
      kind: 'silence',
      languageCode: null,
      text: '',
      wordCount: 0,
    })
  })

  it('rejects payloads without a known kind', () => {
    expect(asMediaTranscript(null)).toBeNull()
    expect(asMediaTranscript({ text: 'orphan' })).toBeNull()
    expect(asMediaTranscript({ kind: 'missing' })).toBeNull()
  })
})

describe('transcriptHasText', () => {
  it('is false for silence, blank text, and absent transcripts', () => {
    expect(transcriptHasText(null)).toBe(false)
    expect(transcriptHasText({
      kind: 'silence',
      languageCode: null,
      text: '',
      wordCount: 0,
    })).toBe(false)
    expect(transcriptHasText({
      kind: 'plain',
      languageCode: null,
      text: '   ',
      wordCount: 0,
    })).toBe(false)
  })

  it('is true when the transcript carries dialog', () => {
    expect(transcriptHasText({
      kind: 'plain',
      languageCode: null,
      text: 'We need to go.',
      wordCount: 4,
    })).toBe(true)
  })
})

describe('transcriptDetailLabel', () => {
  it('describes a timed transcript with language and word count', () => {
    expect(transcriptDetailLabel({
      kind: 'timed',
      languageCode: 'eng',
      text: 'Hello world',
      wordCount: 2,
    })).toBe('Word-timed · 2 words · eng')
  })

  it('singularizes a one-word plain transcript', () => {
    expect(transcriptDetailLabel({
      kind: 'plain',
      languageCode: null,
      text: 'Hello',
      wordCount: 1,
    })).toBe('Plain text · 1 word')
  })

  it('labels silence without counts', () => {
    expect(transcriptDetailLabel({
      kind: 'silence',
      languageCode: null,
      text: '',
      wordCount: 0,
    })).toBe('No dialog detected')
  })
})

describe('asMediaVisionAnalysis', () => {
  it('decodes the compact analysis projection', () => {
    expect(asMediaVisionAnalysis({
      summary: 'A man answers a phone.',
      mood: 'tense',
      setting: 'a kitchen',
      tags: ['phone', '', 'kitchen'],
      subjects: ['man'],
      scene_count: 3,
    })).toEqual({
      summary: 'A man answers a phone.',
      mood: 'tense',
      setting: 'a kitchen',
      tags: ['phone', 'kitchen'],
      subjects: ['man'],
      sceneCount: 3,
    })
  })

  it('rejects non-object payloads', () => {
    expect(asMediaVisionAnalysis(null)).toBeNull()
    expect(asMediaVisionAnalysis('nope')).toBeNull()
  })
})

describe('visionAnalysisDetailLabel', () => {
  it('joins the scene count, mood, and setting', () => {
    expect(visionAnalysisDetailLabel({
      summary: '',
      mood: 'tense',
      setting: 'a kitchen',
      tags: [],
      subjects: [],
      sceneCount: 1,
    })).toBe('1 scene · tense · a kitchen')
  })

  it('is null when nothing is worth showing', () => {
    expect(visionAnalysisDetailLabel({
      summary: 'A summary.',
      mood: null,
      setting: null,
      tags: [],
      subjects: [],
      sceneCount: 0,
    })).toBeNull()
  })
})
