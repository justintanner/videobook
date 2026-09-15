import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CommandComposer } from '../../src/components/videobook/CommandComposer'
import { VoiceComms } from '../../src/components/videobook/VoiceComms'
import { fallbackChatModelCatalog } from '../../src/videobook/chat-models'
import { idleMcpActivity } from '../../src/videobook/mcp-activity'
import type { VoiceConversation } from '../../src/videobook/use-voice-conversation'
import type { VoiceCaption, VoicePhase } from '../../server/src/voice-contract'

function renderComposer(
  modelSelectionDisabled: boolean,
  context: { description: string; label: string } | null = null,
): string {
  return renderToStaticMarkup(createElement(CommandComposer, {
    commands: [],
    references: new Map(),
    actions: [],
    actionContext: { bookId: 'book-1', choices: {} },
    actionDiscovery: null,
    actionStatus: { loading: false, error: null },
    actionsDisabled: false,
    onOpenActions: () => undefined,
    onCloseActionSearch: () => undefined,
    bookId: 'book-1',
    callTool: async () => ({}),
    chatModels: fallbackChatModelCatalog.models,
    disabled: true,
    modelSelectionDisabled,
    connectionLabel: 'Working',
    mcpActivity: idleMcpActivity,
    inputSession: 'chat',
    selectedModel: fallbackChatModelCatalog.defaultModel,
    context,
    onEnsureCatalog: async () => undefined,
    onExecute: async () => ({ ok: true, message: 'Done' }),
    onModelChange: () => undefined,
    onSuccessfulExecute: () => undefined,
  }))
}

function controlMarkup(html: string, label: string): string {
  return html.match(new RegExp(`<[^>]+aria-label="${label}"[^>]*>`))?.[0] ?? ''
}

function stubVoice(overrides: Partial<VoiceConversation> = {}): VoiceConversation {
  return {
    phase: 'listening',
    message: 'Speak naturally. Interrupt anytime.',
    captions: [],
    playbackBlocked: false,
    pendingReview: false,
    meterRef: createRef<HTMLButtonElement>(),
    toggle: () => undefined,
    stop: () => undefined,
    mode: 'auto',
    provider: 'openai',
    fallbackReason: undefined,
    selectMode: () => undefined,
    disabled: false,
    active: true,
    resumePlayback: () => undefined,
    reportOutcome: () => undefined,
    shareTypedTurn: () => undefined,
    ...overrides,
  }
}

function caption(id: string, text: string, role: VoiceCaption['role'] = 'user'): VoiceCaption {
  return { id, role, text, final: true }
}

function renderComms(
  phase: VoicePhase,
  captions: VoiceCaption[],
  captionsVisible?: boolean,
  extras: Partial<VoiceConversation> = {},
): string {
  return renderToStaticMarkup(createElement(VoiceComms, {
    voice: stubVoice({
      phase,
      captions,
      active: phase !== 'off' && phase !== 'error',
      message: phase === 'error' ? 'OPENAI_API_KEY is missing' : 'Speak naturally. Interrupt anytime.',
      ...extras,
    }),
    captionsVisible,
  }))
}

function controlledRegion(html: string): { button: string; region: string; id: string } {
  const id = html.match(/aria-controls="([^"]+)"/)?.[1]
  if (!id) throw new Error('captions control is missing aria-controls')
  const button = html.match(new RegExp(`<button[^>]*aria-controls="${id}"[^>]*>[\\s\\S]*?</button>`))?.[0] ?? ''
  const region = html.match(new RegExp(`<div[^>]*id="${id}"[^>]*>[\\s\\S]*?</div>`))?.[0]
    ?? html.match(new RegExp(`<div[^>]*id="${id}"[^>]*hidden[^>]*>`))?.[0]
    ?? ''
  return { button, region, id }
}

describe('CommandComposer controls', () => {
  it('shows the complete selected model identifier', () => {
    const html = renderComposer(true)

    expect(html).toContain('>gpt-6-astra</option>')
  })

  it('keeps model selection available while command execution is busy', () => {
    const html = renderComposer(false)

    expect(controlMarkup(html, 'Videobook command input')).toContain('disabled')
    expect(controlMarkup(html, 'Chat model')).not.toContain('disabled')
  })

  it('disables model selection when its own availability guard is active', () => {
    expect(controlMarkup(renderComposer(true), 'Chat model')).toContain('disabled')
  })

  it('shows image edit context instead of the chat model selector', () => {
    const html = renderComposer(false, {
      description: 'Two selected subjects',
      label: '@C3 IMAGE EDIT',
    })

    expect(html).toContain('@C3 IMAGE EDIT')
    expect(html).not.toContain('aria-label="Chat model"')
  })

  it('names every composer control without a visible micro-label or color alone', () => {
    const html = renderToStaticMarkup(createElement(CommandComposer, {
      commands: [],
      references: new Map(),
      actions: [],
      actionContext: { bookId: 'book-1', choices: {} },
      actionDiscovery: null,
      actionStatus: { loading: false, error: null },
      actionsDisabled: false,
      onOpenActions: () => undefined,
      onCloseActionSearch: () => undefined,
      bookId: 'book-1',
      callTool: async () => ({}),
      chatModels: fallbackChatModelCatalog.models,
      disabled: false,
      modelSelectionDisabled: false,
      connectionLabel: 'Ready',
      mcpActivity: idleMcpActivity,
      inputSession: 'chat',
      selectedModel: fallbackChatModelCatalog.defaultModel,
      voice: stubVoice({ phase: 'off', active: false, captions: [], message: 'Voice input + spoken replies' }),
      onEnsureCatalog: async () => undefined,
      onExecute: async () => ({ ok: true, message: 'Done' }),
      onModelChange: () => undefined,
      onSuccessfulExecute: () => undefined,
    }))

    expect(html).not.toContain('command-control-kind')
    expect(html).toContain('command-channel')
    expect(controlMarkup(html, 'Chat model')).toContain('aria-label="Chat model"')
    expect(controlMarkup(html, 'Voice provider')).toContain('aria-label="Voice provider"')
    expect(controlMarkup(html, 'Open actions')).toContain('aria-label="Open actions"')
    expect(controlMarkup(html, 'Start voice conversation')).toContain('aria-label="Start voice conversation"')
    expect(controlMarkup(html, 'Send command')).toContain('aria-label="Send command"')
    // Two independently focusable native selects, not one merged control.
    expect(html.match(/<select/g)).toHaveLength(2)
    // The voice half is marked by a glyph, so the halves differ by more than color.
    expect(html).toMatch(/class="voice-provider-field"[^>]*>\s*<svg/)
    // Nothing in the row is named by its position or its color.
    for (const tag of html.match(/<button[^>]*>/g) ?? []) expect(tag).toMatch(/aria-label="[^"]+"/)
  })
})

describe('VoiceComms caption visibility', () => {
  const phases: VoicePhase[] = ['off', 'connecting', 'listening', 'thinking', 'speaking', 'review', 'error']

  it('defaults to a visible transcript region whose name, expanded state and controls agree', () => {
    const html = renderComms('listening', [])
    const { button, region, id } = controlledRegion(html)
    expect(button).toContain('aria-expanded="true"')
    expect(button).toContain('aria-label="Hide captions"')
    expect(button).toMatch(/<svg/)
    expect(button).not.toMatch(/>Hide captions</)
    expect(region).toContain(`id="${id}"`)
    expect(region).not.toContain(' hidden')
    expect(html).toContain('Listening… speak anytime.')
    expect(html).not.toContain('max-height')
  })

  it('hides the transcript body without dropping caption data from the conversation', () => {
    const captions = [caption('1', 'one'), caption('2', 'two', 'assistant'), caption('3', 'three')]
    const shown = renderComms('listening', captions, true)
    const hidden = renderComms('listening', captions, false)
    expect(shown).toContain('>one</span>')
    expect(shown).toContain('>two</span>')
    expect(shown).toContain('>three</span>')
    const { button, region } = controlledRegion(hidden)
    expect(button).toContain('aria-expanded="false"')
    expect(button).toContain('aria-label="Show captions"')
    expect(button).toMatch(/<svg/)
    expect(button).not.toMatch(/>Show captions</)
    expect(region).toContain(' hidden=""')
    expect(hidden).toContain('>one</span>')
    expect(hidden).toContain('>three</span>')
  })

  it('shows an observable empty state for 0 captions across live, waiting, review and stopped phases', () => {
    for (const phase of phases) {
      const html = renderComms(phase, [], true, {
        message: phase === 'off' ? 'Comms off.' : phase === 'error' ? 'OPENAI_API_KEY is missing' : 'Speak naturally. Interrupt anytime.',
        captions: [],
      })
      if (phase === 'off' && html === '') continue
      const { button, region } = controlledRegion(html)
      expect(button, phase).toContain('aria-label="Hide captions"')
      expect(region, phase).toMatch(/Opening|Listening|Transcribing|Waiting|Review|No captions/)
      expect(region, phase).not.toContain(' hidden')
    }
  })

  it('renders 1, 2 and many caption rows and skips blank YOU/COPILOT lines', () => {
    const one = renderComms('listening', [caption('a', 'only row')])
    // The speaker is no longer drawn, so it has to reach a screen reader as text
    // and reach CSS as an attribute. Exactly once, either way.
    expect(one).toContain('<span class="sr-only">YOU</span>')
    expect(one).toContain('data-role="user"')
    expect(one).toContain('only row')
    expect(one.match(/YOU/g)).toHaveLength(1)

    const two = renderComms('speaking', [
      caption('a', 'user line'),
      caption('b', 'assistant line', 'assistant'),
    ])
    expect(two).toContain('user line')
    expect(two).toContain('<span class="sr-only">COPILOT</span>')
    expect(two).toContain('data-role="assistant"')
    expect(two).toContain('assistant line')

    const many = renderComms('thinking', [
      caption('empty', '   '),
      caption('a', 'first'),
      caption('b', 'second', 'assistant'),
      caption('c', 'third'),
      { id: 'cut', role: 'assistant', text: '', final: true, interrupted: true },
    ])
    expect(many.match(/<p data-final=/g)).toHaveLength(4)
    expect(many).toContain('first')
    expect(many).toContain('second')
    expect(many).toContain('third')
    expect(many).toContain('interrupted')

    // Older exchanges leave the panel so it cannot outgrow the work behind it.
    const long = renderComms('thinking', [
      caption('u1', 'oldest ask'),
      caption('a1', 'oldest reply', 'assistant'),
      caption('u2', 'newer ask'),
      caption('a2', 'newer reply', 'assistant'),
      caption('u3', 'newest ask'),
      caption('a3', 'newest reply', 'assistant'),
    ])
    expect(long.match(/<p data-final=/g)).toHaveLength(4)
    expect(long).not.toContain('oldest ask')
    expect(long).not.toContain('oldest reply')
    expect(long).toContain('newer ask')
    expect(long).toContain('newest reply')
  })

  it('keeps Apply/Cancel guidance and the captions toggle as a non-submit button during review', () => {
    const html = renderToStaticMarkup(createElement(CommandComposer, {
      commands: [],
      references: new Map(),
      actions: [],
      actionContext: { bookId: 'book-1', choices: {} },
      actionDiscovery: null,
      actionStatus: { loading: false, error: null },
      actionsDisabled: false,
      onOpenActions: () => undefined,
      onCloseActionSearch: () => undefined,
      bookId: 'book-1',
      callTool: async () => ({}),
      chatModels: fallbackChatModelCatalog.models,
      disabled: false,
      modelSelectionDisabled: false,
      connectionLabel: 'Ready',
      mcpActivity: idleMcpActivity,
      inputSession: 'chat',
      selectedModel: fallbackChatModelCatalog.defaultModel,
      voice: stubVoice({
        phase: 'review',
        pendingReview: true,
        captions: [caption('a', 'make a clip'), caption('b', 'review on screen', 'assistant')],
      }),
      onEnsureCatalog: async () => undefined,
      onExecute: async () => ({ ok: true, message: 'Done' }),
      onModelChange: () => undefined,
      onSuccessfulExecute: () => undefined,
      children: createElement('aside', { className: 'confirm-sheet', 'aria-label': 'Generation review' },
        createElement('footer', { className: 'confirm-sheet-foot' },
          createElement('button', { type: 'button' }, 'Cancel'),
          createElement('button', { type: 'submit', className: 'confirm-sheet-apply' }, 'Apply'),
        ),
      ),
    }))

    expect(html).toContain('Generation review')
    expect(html).toContain('confirm-sheet-apply')
    expect(html).toContain('Cancel')
    expect(html).toContain('Use Apply or Cancel on screen.')
    expect(controlMarkup(html, 'Hide captions')).toContain('type="button"')
    expect(controlMarkup(html, 'Stop voice conversation')).toContain('aria-pressed="true"')
    expect(controlMarkup(html, 'Chat model')).toContain('aria-label="Chat model"')
    expect(controlMarkup(html, 'Voice provider')).toContain('aria-label="Voice provider"')
  })
})
