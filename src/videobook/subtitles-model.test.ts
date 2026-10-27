import { describe, expect, it } from 'vitest'
import { parseSubtitlesRead, placeholderCaptionDocument, subtitlesPreparesBeforeRender, subtitlesRenderBlocker, type SubtitlesRead } from './subtitles-model'

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
