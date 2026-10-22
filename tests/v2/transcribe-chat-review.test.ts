import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConfirmSheet } from '../../src/components/videobook/confirm/ConfirmSheet'
import { TranscribeBody } from '../../src/components/videobook/confirm/bodies/TranscribeBody'
import { transcribeValidation, type TranscribeClipChoice } from '../../src/videobook/transcribe-review'

const clip: TranscribeClipChoice = {
  artifactId: 'vid-1',
  label: '@a1',
  type: 'video',
  mediaUrl: '/files/book/vid-1/proxy.mp4',
  thumbnailUrl: '/files/book/vid-1/original.jpg',
  duration: 12,
}

function renderTranscribe(overrides: {
  clip?: TranscribeClipChoice | null
  languageCode?: string
  diarize?: boolean
  tagAudioEvents?: boolean
} = {}): string {
  const selected = overrides.clip === undefined ? clip : overrides.clip
  const languageCode = overrides.languageCode ?? ''
  return renderToStaticMarkup(createElement(ConfirmSheet, {
    address: selected?.label ?? null,
    applyFormId: 'command-composer-form',
    ariaLabel: 'Transcribe review',
    busy: false,
    children: createElement(TranscribeBody, {
      busy: false,
      clip: selected,
      choices: [clip],
      languageCode,
      diarize: overrides.diarize ?? true,
      tagAudioEvents: overrides.tagAudioEvents ?? true,
      estimateUsd: 0.012,
      estimateLoading: false,
      estimateUnavailable: false,
      onClipChange: () => undefined,
      onLanguageChange: () => undefined,
      onDiarizeChange: () => undefined,
      onTagAudioEventsChange: () => undefined,
    }),
    effect: { label: 'Queues 1 transcription', tone: 'default' },
    kind: 'transcribe',
    tag: 'TRANSCRIBE · CHAT',
    title: selected ? `Transcribe ${selected.label}` : 'Transcribe a clip',
    validation: transcribeValidation({
      assetId: selected?.artifactId ?? null,
      languageCode,
    }),
    onCancel: () => undefined,
  }))
}

describe('transcribe chat review', () => {
  it('renders a composer review instead of a modal dialog', () => {
    const html = renderTranscribe()
    expect(html).toContain('confirm-sheet confirm-sheet-transcribe')
    expect(html).toContain('role="dialog"')
    expect(html).not.toContain('<dialog')
    expect(html).toContain('TRANSCRIBE · CHAT')
    expect(html).toContain('Transcribe @a1')
    expect(html).toContain('Queues 1 transcription')
    expect(html).toContain('form="command-composer-form"')
    expect(html).toContain('class="confirm-sheet-apply">Apply <kbd>↵</kbd>')
    expect(html).toContain('aria-label="Language"')
    expect(html).toContain('placeholder="Auto-detect"')
    expect(html).toContain('>Diarize speakers</span>')
    expect(html).toContain('>Tag audio events</span>')
    expect(html).toContain('ElevenLabs returns word timing')
    expect(html).toContain('OpenAI returns a plain transcript')
    expect(html).toContain('@a1')
    expect(html).toContain('$0.01')
    expect(html).not.toContain('Workspace actions')
    expect(html).not.toContain('confirm-sheet-foot')
  })

  it('blocks apply until a clip is chosen', () => {
    const html = renderTranscribe({ clip: null })
    expect(html).toContain('confirm-sheet-foot confirm-sheet-foot-blocking')
    expect(html).toContain('Choose a video or audio clip.')
    expect(html).toContain('disabled=""')
    expect(html).toContain('No clip')
  })

  it('blocks a language that is not a code', () => {
    const html = renderTranscribe({ languageCode: 'english' })
    expect(html).toContain('Language must be a code such as en or pt-br')
    expect(html).toContain('disabled=""')
  })
})
