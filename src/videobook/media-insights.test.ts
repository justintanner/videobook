import { describe, expect, it } from 'vitest'
import {
  asMediaTranscript,
  asMediaTranscriptSources,
  asMediaVisionAnalysis,
  canDownloadTranscriptSrt,
  formatCueTimestamp,
  formatTranscriptCues,
  resolveTranscriptTab,
  transcriptTabCopyText,
  transcriptTabStates,
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

describe('transcript tabs', () => {
  it('disables missing-source tabs with a reason', () => {
    const states = transcriptTabStates({
      elevenlabs: {
        kind: 'timed',
        languageCode: 'eng',
        text: 'Hello',
        wordCount: 1,
        words: [{ text: 'Hello', start: 0, end: 0.4 }],
      },
      plain: null,
    })
    expect(states.map((tab) => tab.label)).toEqual([
      'ELEVENLABS',
      'PROMPT',
      'JSON',
    ])
    expect(states.find((tab) => tab.id === 'prompt')).toMatchObject({
      enabled: false,
      disabledReason: 'No gpt-4o transcription',
    })
    expect(states.find((tab) => tab.id === 'json')?.enabled).toBe(true)
  })

  it('disables every tab when no sidecar exists', () => {
    const states = transcriptTabStates(null)
    expect(states.every((tab) => !tab.enabled)).toBe(true)
  })

  it('prefers the elevenlabs tab when both sources exist', () => {
    expect(resolveTranscriptTab(asMediaTranscriptSources(twoSourcePayload), null))
      .toBe('elevenlabs')
  })
})

describe('cue formatting', () => {
  it('stamps grouped cues as mm:ss from timed words', () => {
    expect(formatCueTimestamp(65)).toBe('1:05')
    expect(formatTranscriptCues(timedWords)).toBe(
      '0:00  Hello world\n0:05  this later',
    )
  })
})

describe('transcriptTabCopyText', () => {
  it('copies the active tab content', () => {
    const sources = asMediaTranscriptSources(twoSourcePayload)
    expect(transcriptTabCopyText({
      tab: 'elevenlabs',
      sources,
      jsonText: null,
    })).toBe('0:00  Hello world\n0:05  this later')
    expect(transcriptTabCopyText({
      tab: 'prompt',
      sources,
      jsonText: null,
    })).toBe('The gpt-4o transcription.')
    expect(transcriptTabCopyText({
      tab: 'json',
      sources,
      jsonText: '{"text":"raw"}',
    })).toBe('{"text":"raw"}')
  })
})

describe('canDownloadTranscriptSrt', () => {
  it('is true only for a word-timed ElevenLabs source', () => {
    expect(canDownloadTranscriptSrt(asMediaTranscriptSources(twoSourcePayload)))
      .toBe(true)
    expect(canDownloadTranscriptSrt({
      elevenlabs: null,
      plain: {
        kind: 'plain',
        languageCode: null,
        text: 'Plain only.',
        wordCount: 2,
        words: [],
      },
    })).toBe(false)
  })
})
