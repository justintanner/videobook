import { describe, expect, it } from 'vitest'
import { applyCaptionEdits } from '../../server/src/captions/edits'
import type { CaptionDocument } from '../../server/src/captions/model'
import { seedCaptionDocument } from '../../server/src/captions/seed'
import {
  activeSubtitleJobIds,
  parseSubtitlesRead,
  placeholderCaptionDocument,
  resolvedSubtitleDocument,
  subtitleLineProgress,
  subtitlePhraseLines,
  subtitlesBusy,
  subtitlesPreparationLabel,
  subtitlesPreparesBeforeRender,
  subtitlesRenderBlocker,
  type SubtitlesRead,
} from './subtitles-model'

function read(status: SubtitlesRead['status'], message: string | null = null): SubtitlesRead {
  return parseSubtitlesRead({
    asset_id: 'asset',
    language: 'original',
    status,
    message,
    source: { media_hash: 'hash', duration_seconds: 12.25, width: 1080, height: 1920, fps: 30, has_audio: true, label: 'Trailer' },
    components: {},
    paid_work: [{ component: 'regions', provider: 'openai', description: 'Check 4 frames for faces and on-screen text with OpenAI', usd: null }],
    draft: null,
  })
}

describe('subtitles render blocker', () => {
  it('lets Render prepare unprepared or preparing subtitles first instead of refusing', () => {
    for (const status of ['needs_prepare', 'preparing'] as const) {
      expect(subtitlesPreparesBeforeRender(read(status))).toBe(true)
      expect(subtitlesRenderBlocker(read(status), null, false)).toBeNull()
    }
  })

  it('still blocks subtitles that cannot be prepared or have nothing to render', () => {
    expect(subtitlesPreparesBeforeRender(read('failed'))).toBe(false)
    expect(subtitlesRenderBlocker(read('failed', 'Transcription failed.'), null, false)).toBe('Transcription failed.')
    expect(subtitlesRenderBlocker(read('unavailable'), null, false)).toBe('Prepare the subtitles first.')
    expect(subtitlesRenderBlocker(read('silent'), null, false)).toBe('This video has no audio to caption.')
    const ready = read('ready')
    expect(subtitlesRenderBlocker(ready, placeholderCaptionDocument(ready), false)).toBe('There are no words to render.')
    expect(subtitlesRenderBlocker(null, null, false)).toBe('Loading subtitles…')
  })
})

function bilingual(): CaptionDocument {
  const seeded = seedCaptionDocument({
    source: { artifactId: 'asset', mediaHash: 'hash', durationSeconds: 12.25, width: 1080, height: 1920, fps: 30 },
    bindings: { transcriptKey: 't', vocalKey: 'v', translationKey: null },
    language: 'original',
    sourceLanguage: 'th',
    wordTiming: 'measured',
    words: [['ฉัน', 0.5], ['ชอบ', 0.8], ['แมว', 2.5], ['นอน', 2.8]].map(([text, start]) => ({
      text: String(text), start: Number(start), end: Number(start) + 0.25, onset: Number(start), energy: 0.5, speaker: null,
    })),
  })
  return applyCaptionEdits(seeded, [{ op: 'set_translations', translations: [{ language: 'en' }] }])
}

function lined(status: string, memory: Record<string, string>, jobId: number | null = null): SubtitlesRead {
  return parseSubtitlesRead({
    ...read('ready'),
    paid_work: [],
    translations: [{ language: 'en', status, available: status !== 'unavailable', job_id: jobId, error: status === 'unavailable' ? 'Translation lines need OPENAI_API_KEY.' : null, missing_lines: 0 }],
    translation_memory: { en: memory },
  })
}

describe('translated lines in the subtitle editor', () => {
  it('shows remembered lines for the local draft and counts the phrases it still lacks', () => {
    const document = bilingual()
    const [first, second] = document.phrases
    const state = lined('missing', { ฉันชอบ: 'I like it' })
    expect(resolvedSubtitleDocument(document, state).phrases.map((phrase) => phrase.translations)).toEqual([{ en: 'I like it' }, undefined])
    expect(subtitleLineProgress(state, document)).toEqual([{ language: 'en', missing: 1, status: 'missing', available: true, error: null }])
    const own = applyCaptionEdits(document, [{ op: 'set_phrase_translation', phrase_id: second.id, language: 'en', text: 'The cat sleeps' }])
    const lines = subtitlePhraseLines(own, state.translation_memory ?? {})
    expect(lines.get(first.id)).toEqual([{ language: 'en', text: 'I like it', edited: false }])
    expect(lines.get(second.id)).toEqual([{ language: 'en', text: 'The cat sleeps', edited: true }])
    expect(subtitleLineProgress(state, own)).toEqual([{ language: 'en', missing: 0, status: 'missing', available: true, error: null }])
  })

  it('translates before rendering, waits while translating and blocks lines that cannot be translated', () => {
    const document = bilingual()
    const missing = lined('missing', {})
    expect(subtitlesPreparesBeforeRender(missing, document)).toBe(true)
    expect(subtitlesRenderBlocker(missing, document, false)).toBeNull()
    const running = lined('running', {}, 41)
    expect(subtitlesPreparesBeforeRender(running, document)).toBe(true)
    expect(subtitlesBusy(running)).toBe(true)
    expect(subtitlesPreparationLabel(running)).toBe('Translating lines…')
    expect(activeSubtitleJobIds(running)).toEqual([41])
    const unavailable = lined('unavailable', {})
    expect(subtitlesPreparesBeforeRender(unavailable, document)).toBe(false)
    expect(subtitlesRenderBlocker(unavailable, document, false)).toBe('Translation lines need OPENAI_API_KEY.')
    const done = lined('ready', { ฉันชอบ: 'I like it', แมวนอน: 'The cat sleeps' })
    expect(subtitlesPreparesBeforeRender(done, document)).toBe(false)
    expect(subtitlesRenderBlocker(done, document, false)).toBeNull()
    expect(subtitlesBusy(done)).toBe(false)
  })
})
