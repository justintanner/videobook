import { describe, expect, it } from 'vitest'
import {
  asMediaTranscript,
  asMediaTranscriptSources,
  asMediaVisionAnalysis,
  canDownloadTranscriptSrt,
  formatCueTimestamp,
  formatTranscriptCues,
  resolveTranscriptCardView,
  transcriptSourceBody,
  transcriptSourceCopyText,
  transcriptSourceEmptyMessage,
  transcriptSourceMeta,
  visionAnalysisDetailLabel,
  transcriptDetailLabel,
  transcriptHasText,
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
      words: [],
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
      words: [],
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
      words: [],
    })).toBe(false)
    expect(transcriptHasText({
      kind: 'plain',
      languageCode: null,
      text: '   ',
      wordCount: 0,
      words: [],
    })).toBe(false)
  })

  it('is true when the transcript carries dialog', () => {
    expect(transcriptHasText({
      kind: 'plain',
      languageCode: null,
      text: 'We need to go.',
      wordCount: 4,
      words: [],
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
      words: [],
    })).toBe('Word-timed · 2 words · eng')
  })

  it('singularizes a one-word plain transcript', () => {
    expect(transcriptDetailLabel({
      kind: 'plain',
      languageCode: null,
      text: 'Hello',
      wordCount: 1,
      words: [],
    })).toBe('Plain text · 1 word')
  })

  it('labels silence without counts', () => {
    expect(transcriptDetailLabel({
      kind: 'silence',
      languageCode: null,
      text: '',
      wordCount: 0,
      words: [],
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

const timedWords = [
  { text: 'Hello', start: 0, end: 0.4 },
  { text: 'world', start: 0.45, end: 0.9 },
  { text: 'this', start: 5.2, end: 5.5 },
  { text: 'later', start: 5.55, end: 6 },
]

const twoSourcePayload = {
  elevenlabs: {
    kind: 'timed',
    language_code: 'eng',
    text: 'Hello world this later',
    word_count: 4,
    words: timedWords,
  },
  plain: {
    kind: 'plain',
    text: 'The gpt-4o transcription.',
    word_count: 3,
  },
}

describe('asMediaTranscriptSources', () => {
  it('decodes both compact sources without a raw JSON blob', () => {
    expect(asMediaTranscriptSources(twoSourcePayload)).toEqual({
      elevenlabs: {
        kind: 'timed',
        languageCode: 'eng',
        text: 'Hello world this later',
        wordCount: 4,
        words: timedWords,
      },
      plain: {
        kind: 'plain',
        languageCode: null,
        text: 'The gpt-4o transcription.',
        wordCount: 3,
        words: [],
      },
    })
    expect(JSON.stringify(twoSourcePayload)).not.toContain('transcription_id')
  })

  it('wraps a legacy single timed summary as elevenlabs', () => {
    expect(asMediaTranscriptSources({
      kind: 'timed',
      language_code: 'eng',
      text: 'Hello',
      word_count: 1,
    })?.elevenlabs?.kind).toBe('timed')
  })

  it('rejects an empty two-source object', () => {
    expect(asMediaTranscriptSources({ elevenlabs: null, plain: null })).toBeNull()
  })
})

describe('per-source transcript cards', () => {
  const sources = asMediaTranscriptSources(twoSourcePayload)
  const plainOnly = {
    elevenlabs: null,
    plain: {
      kind: 'plain' as const,
      languageCode: null,
      text: 'Plain only.',
      wordCount: 2,
      words: [],
    },
  }
  const elevenlabsOnly = {
    elevenlabs: {
      kind: 'timed' as const,
      languageCode: 'eng',
      text: 'Hello world this later',
      wordCount: 4,
      words: timedWords,
    },
    plain: null,
  }
  const silence = {
    kind: 'silence' as const,
    languageCode: null,
    text: '',
    wordCount: 0,
    words: [],
  }

  it('keeps GPT-4o copy, body, and meta free of ElevenLabs cues', () => {
    const copy = transcriptSourceCopyText({
      source: 'plain',
      transcript: sources!.plain,
      view: 'text',
      jsonText: '{"elevenlabs":"must-not-leak"}',
    })
    const body = transcriptSourceBody({
      source: 'plain',
      transcript: sources!.plain,
      view: 'text',
      jsonText: '{"elevenlabs":"must-not-leak"}',
    })
    const meta = transcriptSourceMeta({
      transcript: sources!.plain,
      view: 'text',
      jsonFile: 'elevenlabs.json',
    })
    expect(copy).toBe('The gpt-4o transcription.')
    expect(body).toBe('The gpt-4o transcription.')
    expect(meta).toBe('Plain text · 3 words')
    expect(copy).not.toContain('0:00')
    expect(body).not.toContain('Hello world')
    expect(meta).not.toContain('Word-timed')
    expect(meta).not.toContain('elevenlabs.json')
  })

  it('formats ElevenLabs copy from timed cues when words exist', () => {
    expect(transcriptSourceCopyText({
      source: 'elevenlabs',
      transcript: sources!.elevenlabs,
      view: 'text',
      jsonText: '{"plain":"must-not-leak"}',
    })).toBe('0:00  Hello world\n0:05  this later')
    expect(transcriptSourceBody({
      source: 'elevenlabs',
      transcript: sources!.elevenlabs,
      view: 'text',
      jsonText: null,
    })).toBe('0:00  Hello world\n0:05  this later')
    expect(transcriptSourceMeta({
      transcript: sources!.elevenlabs,
      view: 'text',
      jsonFile: '.analysis.gpt4otrans.json',
    })).toBe('Word-timed · 4 words · eng')
  })

  it('uses each source sidecar for JSON copy and meta', () => {
    expect(transcriptSourceCopyText({
      source: 'plain',
      transcript: sources!.plain,
      view: 'json',
      jsonText: '{"text":"gpt4o"}',
    })).toBe('{"text":"gpt4o"}')
    expect(transcriptSourceMeta({
      transcript: sources!.plain,
      view: 'json',
      jsonFile: '.analysis.gpt4otrans.json',
    })).toBe('Raw sidecar · .analysis.gpt4otrans.json')
    expect(transcriptSourceCopyText({
      source: 'elevenlabs',
      transcript: sources!.elevenlabs,
      view: 'json',
      jsonText: '{"text":"scribe"}',
    })).toBe('{"text":"scribe"}')
    expect(transcriptSourceMeta({
      transcript: sources!.elevenlabs,
      view: 'json',
      jsonFile: 'elevenlabs.json',
    })).toBe('Raw sidecar · elevenlabs.json')
  })

  it('keeps dual-source, single-source, silence, and missing cases distinct', () => {
    expect(transcriptSourceCopyText({
      source: 'plain',
      transcript: sources!.plain,
      view: 'text',
      jsonText: null,
    })).not.toBe(transcriptSourceCopyText({
      source: 'elevenlabs',
      transcript: sources!.elevenlabs,
      view: 'text',
      jsonText: null,
    }))
    expect(transcriptSourceCopyText({
      source: 'plain',
      transcript: plainOnly.plain,
      view: 'text',
      jsonText: null,
    })).toBe('Plain only.')
    expect(transcriptSourceCopyText({
      source: 'elevenlabs',
      transcript: plainOnly.elevenlabs,
      view: 'text',
      jsonText: null,
    })).toBe('')
    expect(transcriptSourceCopyText({
      source: 'elevenlabs',
      transcript: elevenlabsOnly.elevenlabs,
      view: 'text',
      jsonText: null,
    })).toContain('0:00')
    expect(transcriptSourceCopyText({
      source: 'plain',
      transcript: elevenlabsOnly.plain,
      view: 'text',
      jsonText: null,
    })).toBe('')
    expect(transcriptSourceCopyText({
      source: 'plain',
      transcript: silence,
      view: 'text',
      jsonText: null,
    })).toBe('')
    expect(transcriptSourceEmptyMessage({
      source: 'plain',
      transcript: silence,
      view: 'text',
      jsonLoading: false,
      jsonError: null,
      body: '',
    })).toBe('This clip has a transcript but no spoken dialog.')
    expect(transcriptSourceEmptyMessage({
      source: 'plain',
      transcript: null,
      view: 'text',
      jsonLoading: false,
      jsonError: null,
      body: '',
    })).toBe('No GPT-4o translation yet.')
    expect(transcriptSourceEmptyMessage({
      source: 'elevenlabs',
      transcript: null,
      view: 'text',
      jsonLoading: false,
      jsonError: null,
      body: '',
    })).toBe('No transcript yet.')
    expect(resolveTranscriptCardView(null, 'json')).toBe('text')
    expect(resolveTranscriptCardView(sources!.plain, 'json')).toBe('json')
  })
})

describe('cue formatting', () => {
  it('stamps grouped cues as mm:ss from timed words', () => {
    expect(formatCueTimestamp(65)).toBe('1:05')
    expect(formatTranscriptCues(timedWords)).toBe(
      '0:00  Hello world\n0:05  this later',
    )
  })

  it('joins Thai words without spaces and keeps the space before a Latin word', () => {
    expect(formatTranscriptCues([
      { text: 'ฉัน', start: 0, end: 0.5 },
      { text: 'ชอบ', start: 0.5, end: 1 },
      { text: 'Bangkok', start: 1, end: 1.5 },
    ])).toBe('0:00  ฉันชอบ Bangkok')
  })
})

describe('canDownloadTranscriptSrt', () => {
  it('is true only for a word-timed ElevenLabs source', () => {
    const sources = asMediaTranscriptSources(twoSourcePayload)
    expect(canDownloadTranscriptSrt(sources!.elevenlabs)).toBe(true)
    expect(canDownloadTranscriptSrt(sources!.plain)).toBe(false)
    expect(canDownloadTranscriptSrt({
      kind: 'plain',
      languageCode: null,
      text: 'Plain only.',
      wordCount: 2,
      words: [],
    })).toBe(false)
    expect(canDownloadTranscriptSrt({
      kind: 'silence',
      languageCode: null,
      text: '',
      wordCount: 0,
      words: [],
    })).toBe(false)
    expect(canDownloadTranscriptSrt(null)).toBe(false)
  })
})
