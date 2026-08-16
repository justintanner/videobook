import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CommandComposer } from '../../src/components/videobook/CommandComposer'
import { SpeakCommandPreview } from '../../src/components/videobook/SpeakCommandPreview'
import { fallbackChatModelCatalog } from '../../src/videobook/chat-models'
import { idleMcpActivity } from '../../src/videobook/mcp-activity'
import {
  handleSpeakPreviewKey,
  nextSpeakVoiceId,
  resolveSpeakPreviewAction,
  resolveSpeakVoiceId,
  speakCommandText,
  speakExecuteContext,
  SPEAK_PREVIEW_PREFILL,
} from '../../src/videobook/speak-preview'
import type { SpeakVoice } from '../../src/videobook/use-elevenlabs-voices'

const voices: SpeakVoice[] = [
  {
    voiceId: 'voice-a',
    name: 'Ada',
    source: 'custom',
    category: 'cloned',
    previewUrl: 'https://example.test/ada.mp3',
  },
  {
    voiceId: 'voice-b',
    name: 'Bella',
    source: 'generic',
    category: 'premade',
    previewUrl: 'https://example.test/bella.mp3',
  },
  {
    voiceId: 'voice-c',
    name: 'Cora',
    source: 'generic',
  },
]

describe('speak preview helpers', () => {
  it('extracts speech text after /speak', () => {
    expect(speakCommandText('/speak')).toBe('')
    expect(speakCommandText('/speak welcome back everyone')).toBe('welcome back everyone')
  })

  it('prefers a stored voice and wraps arrow selection', () => {
    expect(resolveSpeakVoiceId(voices, 'voice-b')).toBe('voice-b')
    expect(resolveSpeakVoiceId(voices, 'missing')).toBe('voice-a')
    expect(nextSpeakVoiceId(voices, 'voice-a', 1)).toBe('voice-b')
    expect(nextSpeakVoiceId(voices, 'voice-c', 1)).toBe('voice-a')
    expect(nextSpeakVoiceId(voices, 'voice-a', -1)).toBe('voice-c')
  })

  it('passes the selected voice id on speak submit', () => {
    expect(speakExecuteContext('/speak welcome back', 'voice-b')).toEqual({
      speakVoiceId: 'voice-b',
    })
    expect(speakExecuteContext('/say hello', 'voice-b')).toBeUndefined()
  })

  it('prefills /speak from /voices and keeps other commands out of generation', () => {
    expect(resolveSpeakPreviewAction({
      command: '/voices',
      text: '',
      hasNotebook: false,
    })).toEqual({
      kind: 'prefill',
      nextInput: SPEAK_PREVIEW_PREFILL,
      message: 'Choose a voice, then type the speech text.',
    })
    expect(resolveSpeakPreviewAction({
      command: '/speak',
      text: 'welcome back',
      voiceId: 'voice-b',
      hasNotebook: true,
    })).toEqual({
      kind: 'generate',
      text: 'welcome back',
      voiceId: 'voice-b',
    })
    expect(resolveSpeakPreviewAction({
      command: '/speak',
      text: 'welcome back',
      voiceId: 'voice-b',
      hasNotebook: false,
    })).toMatchObject({ kind: 'error' })
  })
})

describe('SpeakCommandPreview panel', () => {
  it('renders the full catalog with selection, badges, and fallback warning', () => {
    const html = renderToStaticMarkup(createElement(SpeakCommandPreview, {
      voices,
      selectedVoiceId: 'voice-b',
      playingVoiceId: 'voice-a',
      status: 'fallback',
      warning: 'ELEVENLABS_API_KEY is not configured; showing configured custom IDs and generic fallback IDs.',
      loading: false,
      error: null,
      onSelect: () => undefined,
      onTogglePreview: () => undefined,
    }))

    expect(html).toContain('data-testid="speak-command-preview"')
    expect(html).toContain('Ada')
    expect(html).toContain('Bella')
    expect(html).toContain('Cora')
    expect(html).toContain('custom · cloned')
    expect(html).toContain('generic · premade')
    expect(html).toContain('Pause')
    expect(html).toContain('Preview')
    expect(html).toContain('speak-preview-voice selected')
    expect(html).toContain('data-voice-id="voice-b"')
    expect(html).toContain('ELEVENLABS_API_KEY is not configured')
    expect(html).toContain('Bella')
    expect(html).toContain('↑↓ voice')
  })

  it('shows a loading state before any voices arrive', () => {
    const html = renderToStaticMarkup(createElement(SpeakCommandPreview, {
      voices: [],
      selectedVoiceId: '',
      playingVoiceId: null,
      status: 'fallback',
      warning: null,
      loading: true,
      error: null,
      onSelect: () => undefined,
      onTogglePreview: () => undefined,
    }))

    expect(html).toContain('Loading voices…')
  })
})

describe('speak preview keyboard flow', () => {
  it('moves selection with arrows and submits the selected voice id', async () => {
    let selectedVoiceId = 'voice-a'
    const down = handleSpeakPreviewKey(
      { key: 'ArrowDown', code: 'ArrowDown', ctrlKey: false },
      voices,
      selectedVoiceId,
    )
    expect(down).toEqual({ type: 'select', voiceId: 'voice-b' })
    if (down.type === 'select') selectedVoiceId = down.voiceId

    const tab = handleSpeakPreviewKey(
      { key: 'Tab', code: 'Tab', ctrlKey: false },
      voices,
      selectedVoiceId,
    )
    expect(tab).toEqual({ type: 'select', voiceId: 'voice-b' })

    const preview = handleSpeakPreviewKey(
      { key: ' ', code: 'Space', ctrlKey: true },
      voices,
      selectedVoiceId,
    )
    expect(preview).toEqual({ type: 'toggle' })

    const calls: Array<{ input: string; context?: { speakVoiceId?: string } }> = []
    const onExecute = async (
      input: string,
      context?: { speakVoiceId?: string },
    ) => {
      calls.push({ input, context })
      return { ok: true, message: '@a1 queued' }
    }
    const outcome = await onExecute(
      '/speak welcome back',
      speakExecuteContext('/speak welcome back', selectedVoiceId),
    )

    expect(outcome).toEqual({ ok: true, message: '@a1 queued' })
    expect(calls[0]).toEqual({
      input: '/speak welcome back',
      context: { speakVoiceId: 'voice-b' },
    })
    expect(handleSpeakPreviewKey(
      { key: 'Escape', code: 'Escape', ctrlKey: false },
      voices,
      selectedVoiceId,
    )).toEqual({ type: 'dismiss' })
  })
})

describe('CommandComposer /voices prefill', () => {
  it('renders the speak preview when input is prefilled to /speak ', () => {
    const html = renderToStaticMarkup(createElement(CommandComposer, {
      commands: [{
        command: '/speak',
        description: 'Generate ElevenLabs speech into the notebook from the inline voice preview',
        category: 'action',
        icon: 'Mic',
        size: 'default',
        variant: 'pink',
        chevron: 'right',
        params: [],
        uiAction: 'speak_preview',
      }],
      cells: [],
      bookId: 'book-1',
      callTool: async () => ({}),
      chatModels: fallbackChatModelCatalog.models,
      disabled: false,
      modelSelectionDisabled: false,
      connectionLabel: 'Ready',
      mcpActivity: idleMcpActivity,
      selectedModel: fallbackChatModelCatalog.defaultModel,
      pendingInput: '/speak ',
      voiceCatalog: {
        voices,
        status: 'fallback',
        warning: 'ELEVENLABS_API_KEY is not configured; showing configured custom IDs and generic fallback IDs.',
        loading: false,
        error: null,
        refresh: async () => ({
          voices,
          status: 'fallback' as const,
          warning: null,
        }),
      },
      onEnsureCatalog: async () => undefined,
      onExecute: async () => ({ ok: true, message: 'Done' }),
      onModelChange: () => undefined,
      onSuccessfulExecute: () => undefined,
    }))

    expect(html).toContain('data-testid="speak-command-preview"')
    expect(html).toContain('Ada')
    expect(html).toContain('value="/speak "')
    expect(html).not.toContain('speak-backdrop')
    expect(html).not.toContain('Speak dialog')
  })
})

describe('speak dialog retirement', () => {
  it('keeps App on the inline preview and drops SpeakDialog plumbing', () => {
    const app = readFileSync(resolve(import.meta.dirname, '../../src/App.tsx'), 'utf8')
    const css = readFileSync(resolve(import.meta.dirname, '../../src/index.css'), 'utf8')
    expect(app).toContain('useElevenLabsVoices')
    expect(app).toContain('runSpeakGeneration')
    expect(app).toContain('voiceCatalog={elevenLabsVoices}')
    expect(app).not.toContain('SpeakDialog')
    expect(app).not.toContain('openSpeakDialog')
    expect(app).not.toContain('show_voices')
    expect(app).not.toContain('open_speak')
    expect(css).not.toContain('.speak-backdrop')
    expect(css).not.toContain('.speak-dialog')
  })
})
