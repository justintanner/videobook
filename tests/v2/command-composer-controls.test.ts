import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CommandComposer } from '../../src/components/videobook/CommandComposer'
import {
  COMPOSER_DOCK_HIDE_LABEL,
  composerDockDraftKey,
  composerDockReviewPriority,
  composerDockShouldOpen,
  hideComposerDock,
  initialMusicDockView,
} from '../../src/videobook/composer-dock'
import { ComposerHistory } from '../../src/components/videobook/ComposerHistory'
import { composerHistory } from '../../src/videobook/composer-history'
import { VoiceComms } from '../../src/components/videobook/VoiceComms'
import { fallbackChatModelCatalog } from '../../src/videobook/chat-models'
import {
  composerEngineMenu,
  engineMenuInitialIndex,
  engineMenuItems,
} from '../../src/videobook/composer-engine-menu'
import { emptyMcpCallLog } from '../../src/videobook/mcp-activity'
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
    mcpCalls: emptyMcpCallLog,
    mcpFlash: null,
    onToggleMcpCall: () => {},
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
    retrying: false,
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
  extras: Partial<VoiceConversation> = {},
): string {
  return renderToStaticMarkup(createElement(VoiceComms, {
    voice: stubVoice({
      phase,
      captions,
      active: phase !== 'off' && phase !== 'error',
      message: phase === 'error' ? 'OPENAI_API_KEY is missing' : phase === 'connecting' ? 'Connecting voice' : 'Speak naturally. Interrupt anytime.',
      ...extras,
    }),
  }))
}

function renderHistory(
  phase: VoicePhase,
  captions: VoiceCaption[],
  open = true,
): string {
  return renderToStaticMarkup(createElement(ComposerHistory, {
    rows: composerHistory(captions, emptyMcpCallLog),
    phase,
    voicePresent: true,
    open,
    onToggle: () => undefined,
    onClose: () => undefined,
    onToggleCall: () => undefined,
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
  it('shows the model by name on the bar and keeps its full id for the menu', () => {
    const html = renderComposer(true)

    // The bar carries the short name; gpt-6-astra now lives one click deep, in
    // the engine menu, which is closed in this static render.
    expect(controlMarkup(html, 'Chat model')).toContain('aria-haspopup="menu"')
    expect(html).toContain('>Astra</span>')
    expect(html).not.toContain('gpt-6-astra')
  })

  it('offers the model and the speech provider from the one engine menu', () => {
    const groups = composerEngineMenu({
      chatModels: fallbackChatModelCatalog.models,
      selectedModel: fallbackChatModelCatalog.defaultModel,
      modelSelectable: true,
      voiceMode: 'auto',
    })

    expect(groups.map((group) => group.id)).toEqual(['model', 'speech'])
    const items = engineMenuItems(groups)
    expect(items.map((item) => item.label)).toEqual(['Astra', 'Auto', 'OpenAI', 'xAI'])
    expect(items.map((item) => item.position)).toEqual([0, 1, 2, 3])
    expect(items.find((item) => item.label === 'Astra')?.detail).toBe('gpt-6-astra')
    // The provider stays pickable from text mode, before voice is ever started.
    expect(engineMenuInitialIndex(items)).toBe(0)
    expect(items.filter((item) => item.checked).map((item) => item.label)).toEqual(['Astra', 'Auto'])
  })

  it('drops the model group when a context composer owns the request', () => {
    const groups = composerEngineMenu({
      chatModels: fallbackChatModelCatalog.models,
      selectedModel: fallbackChatModelCatalog.defaultModel,
      modelSelectable: false,
      voiceMode: 'openai',
    })

    expect(groups.map((group) => group.id)).toEqual(['speech'])
    expect(engineMenuItems(groups).map((item) => item.position)).toEqual([0, 1, 2])
  })

  it('keeps model selection available while command execution is busy', () => {
    const html = renderComposer(false)

    expect(controlMarkup(html, 'Videobook command input')).toContain('disabled')
    expect(controlMarkup(html, 'Chat model')).not.toContain('disabled')
  })

  it('disables model selection when its own availability guard is active', () => {
    expect(controlMarkup(renderComposer(true), 'Chat model')).toContain('disabled')
  })

  it('shows image edit context instead of the chat model name', () => {
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
      mcpCalls: emptyMcpCallLog,
      mcpFlash: null,
      onToggleMcpCall: () => {},
      inputSession: 'chat',
      selectedModel: fallbackChatModelCatalog.defaultModel,
      voice: stubVoice({ phase: 'off', active: false, captions: [], message: 'Voice input + spoken replies' }),
      onEnsureCatalog: async () => undefined,
      onExecute: async () => ({ ok: true, message: 'Done' }),
      onModelChange: () => undefined,
      onSuccessfulExecute: () => undefined,
    }))

    expect(html).not.toContain('command-control-kind')
    expect(html).toContain('composer-mode-switch')
    // Voice is off, so the strip is the lit text cell plus the idle microphone.
    expect(controlMarkup(html, 'Chat model')).toContain('aria-label="Chat model"')
    expect(controlMarkup(html, 'Chat model')).toContain('composer-mode-cell-live')
    expect(html).toContain('>TEXT</span>')
    expect(controlMarkup(html, 'Open actions')).toContain('aria-label="Open actions"')
    expect(controlMarkup(html, 'Start voice conversation')).toContain('aria-pressed="false"')
    expect(controlMarkup(html, 'Start voice conversation')).toContain('composer-mode-cell-idle')
    expect(controlMarkup(html, 'Send command')).toContain('aria-label="Send command"')
    // The old pair of native selects is gone; one menu button carries both.
    expect(html.match(/<select/g)).toBeNull()
    expect(html).not.toContain('aria-label="Voice provider"')
    // Nothing in the row is named by its position or its color.
    for (const tag of html.match(/<button[^>]*>/g) ?? []) expect(tag).toMatch(/aria-label="[^"]+"/)
  })

  it('keeps an enabled collapse control in expanded loading, error, action search and pending review states', () => {
    const hide = (html: string) => controlMarkup(html, COMPOSER_DOCK_HIDE_LABEL)
    expect(hide(renderComposer(false))).toBe('')
    expect(hide(renderComposer(true))).toBe('')

    const loading = renderToStaticMarkup(createElement(CommandComposer, {
      commands: [],
      references: new Map(),
      actions: [],
      actionContext: { bookId: 'book-1', choices: {} },
      actionDiscovery: { key: 1, query: 'generate' },
      dockOpen: true,
      actionStatus: { loading: true, error: null },
      actionsDisabled: true,
      onOpenActions: () => undefined,
      onCloseActionSearch: () => undefined,
      bookId: 'book-1',
      callTool: async () => ({}),
      chatModels: fallbackChatModelCatalog.models,
      disabled: true,
      modelSelectionDisabled: true,
      connectionLabel: 'Connecting to MCP…',
      mcpCalls: emptyMcpCallLog,
      mcpFlash: null,
      onToggleMcpCall: () => {},
      inputSession: 'chat',
      selectedModel: fallbackChatModelCatalog.defaultModel,
      notice: { message: 'Could not load actions', tone: 'error' },
      onEnsureCatalog: async () => undefined,
      onExecute: async () => ({ ok: true, message: 'Done' }),
      onModelChange: () => undefined,
      onSuccessfulExecute: () => undefined,
    }))
    expect(hide(loading)).toContain(`aria-label="${COMPOSER_DOCK_HIDE_LABEL}"`)
    expect(hide(loading)).not.toContain('disabled')
    expect(loading).toContain('Could not load actions')
    expect(loading).toContain('Loading actions')
    expect(loading).toContain('aria-label="Close action search"')

    const reviewing = renderToStaticMarkup(createElement(CommandComposer, {
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
      mcpCalls: emptyMcpCallLog,
      mcpFlash: null,
      onToggleMcpCall: () => {},
      inputSession: 'chat',
      selectedModel: fallbackChatModelCatalog.defaultModel,
      voice: stubVoice({ phase: 'review', pendingReview: true }),
      dockOpen: true,
      onEnsureCatalog: async () => undefined,
      onExecute: async () => ({ ok: true, message: 'Done' }),
      onModelChange: () => undefined,
      onSuccessfulExecute: () => undefined,
      children: createElement('aside', { className: 'confirm-sheet', 'aria-label': 'Generation review' },
        createElement('button', { type: 'button' }, 'Cancel'),
      ),
    }))
    expect(hide(reviewing)).toContain(`aria-label="${COMPOSER_DOCK_HIDE_LABEL}"`)
    expect(hide(reviewing)).not.toContain('disabled')
    expect(reviewing).toContain('Generation review')
    expect(reviewing).toContain('Cancel')
  })

  it('collapses panels while keeping the normal input without writing or cancelling', () => {
    const dismissPending = () => {
      throw new Error('hide must not dismiss a pending review')
    }
    const apply = () => {
      throw new Error('hide must not apply')
    }
    const save = () => {
      throw new Error('hide must not save')
    }
    const cancel = () => {
      throw new Error('hide must not cancel')
    }
    let open = true
    hideComposerDock({
      setOpen: (next) => { open = next },
      dismissPending,
      apply,
      save,
      cancel,
    })
    expect(open).toBe(false)

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
      dockOpen: false,
      bookId: 'book-1',
      callTool: async () => ({}),
      chatModels: fallbackChatModelCatalog.models,
      disabled: false,
      modelSelectionDisabled: false,
      connectionLabel: 'Ready',
      mcpCalls: emptyMcpCallLog,
      mcpFlash: null,
      onToggleMcpCall: () => {},
      inputSession: 'chat',
      selectedModel: fallbackChatModelCatalog.defaultModel,
      onEnsureCatalog: async () => undefined,
      onExecute: async () => ({ ok: true, message: 'Done' }),
      onModelChange: () => undefined,
      onSuccessfulExecute: () => undefined,
      children: createElement('aside', { className: 'confirm-sheet', 'aria-label': 'Generation review' },
        createElement('button', { type: 'button' }, 'Cancel'),
      ),
    }))
    expect(html).not.toContain('Show chat')
    expect(controlMarkup(html, 'Videobook command input')).toContain('aria-label="Videobook command input"')
    expect(controlMarkup(html, 'Send command')).toContain('aria-label="Send command"')
    expect(controlMarkup(html, COMPOSER_DOCK_HIDE_LABEL)).toBe('')
    expect(html).toMatch(/class="command-composer-dock-body"[^>]*hidden/)
    expect(html).toContain('Generation review')
  })

  it('isolates drafts by project and editing target and does not reopen from completions', () => {
    expect(composerDockDraftKey('book-a', 'cell-1')).not.toBe(composerDockDraftKey('book-b', 'cell-1'))
    expect(composerDockDraftKey('book-a', 'cell-1')).not.toBe(composerDockDraftKey('book-a', 'cell-2'))
    expect(composerDockDraftKey('book-a', null)).toBe('book-a:chat')
    expect(composerDockShouldOpen('selection')).toBe(true)
    expect(composerDockShouldOpen('action')).toBe(true)
    expect(composerDockShouldOpen('expand')).toBe(true)
    expect(composerDockShouldOpen('reopen')).toBe(true)
    expect(composerDockShouldOpen('completion')).toBe(false)
    expect(composerDockShouldOpen('poll')).toBe(false)
    expect(composerDockReviewPriority(true)).toBe(true)
    expect(composerDockReviewPriority(false)).toBe(false)
    expect(initialMusicDockView('applied')).toBe('sources')
    expect(initialMusicDockView('needs-audio-track')).toBe('soundtrack')
    expect(initialMusicDockView('ready')).toBe('soundtrack')
  })
})

describe('VoiceComms caption visibility', () => {
  const phases: VoicePhase[] = ['off', 'connecting', 'listening', 'thinking', 'speaking', 'review', 'error']

  it('defaults to a visible transcript region whose name, expanded state and controls agree', () => {
    const html = renderHistory('listening', [])
    const { button, region, id } = controlledRegion(html)
    expect(button).toContain('aria-expanded="true"')
    expect(button).toContain('aria-label="Close history"')
    expect(button).toMatch(/<svg/)
    expect(button).not.toMatch(/>Close history</)
    expect(region).toContain(`id="${id}"`)
    expect(region).not.toContain(' hidden')
    expect(html).toContain('Listening… speak anytime.')
    expect(html).not.toContain('max-height')
  })

  it('hides the transcript body without dropping caption data from the conversation', () => {
    const captions = [caption('1', 'one'), caption('2', 'two', 'assistant'), caption('3', 'three')]
    const shown = renderHistory('listening', captions, true)
    const hidden = renderHistory('listening', captions, false)
    expect(shown).toContain('>one</span>')
    expect(shown).toContain('>two</span>')
    expect(shown).toContain('>three</span>')
    const { button, region } = controlledRegion(hidden)
    expect(button).toContain('aria-expanded="false"')
    expect(button).toContain('aria-label="Show history"')
    expect(button).toMatch(/<svg/)
    expect(button).not.toMatch(/>Show history</)
    expect(region).toContain(' hidden=""')
    expect(hidden).toContain('>one</span>')
    expect(hidden).toContain('>three</span>')
  })

  it('shows an observable empty state for 0 captions across live, waiting, review and stopped phases', () => {
    for (const phase of phases) {
      if (phase === 'off') continue
      const html = renderHistory(phase, [], true)
      const { button, region } = controlledRegion(html)
      expect(button, phase).toContain('aria-label="Close history"')
      expect(region, phase).toMatch(/Opening|Listening|Transcribing|Waiting|Review|No captions/)
      expect(region, phase).not.toContain(' hidden')
    }
  })

  it('renders 1, 2 and many caption rows and skips blank YOU/COPILOT lines', () => {
    const one = renderHistory('listening', [caption('a', 'only row')])
    // The speaker is no longer drawn, so it has to reach a screen reader as text
    // and reach CSS as an attribute. Exactly once, either way.
    expect(one).toContain('<span class="sr-only">YOU</span>')
    expect(one).toContain('data-role="user"')
    expect(one).toContain('only row')
    expect(one.match(/YOU/g)).toHaveLength(1)

    const two = renderHistory('speaking', [
      caption('a', 'user line'),
      caption('b', 'assistant line', 'assistant'),
    ])
    expect(two).toContain('user line')
    expect(two).toContain('<span class="sr-only">COPILOT</span>')
    expect(two).toContain('data-role="assistant"')
    expect(two).toContain('assistant line')

    const many = renderHistory('thinking', [
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
    const long = renderHistory('thinking', [
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
      mcpCalls: emptyMcpCallLog,
      mcpFlash: null,
      onToggleMcpCall: () => {},
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
    expect(controlMarkup(html, 'Close history')).toContain('type="button"')
    // Talking, the strip flips: the text cell becomes the way out and the voice
    // cell is the lit one, naming the provider that is carrying the call.
    expect(controlMarkup(html, 'Stop voice conversation')).toContain('aria-pressed="true"')
    expect(controlMarkup(html, 'Stop voice conversation')).toContain('composer-mode-cell-idle')
    expect(controlMarkup(html, 'Voice provider')).toContain('composer-mode-cell-live')
    expect(html).toContain('>VOICE</span>')
    expect(html).not.toContain('aria-label="Chat model"')
  })

  it('keeps Connecting voice distinct from Waiting for reply in the statusline', () => {
    expect(renderComms('connecting', [])).toContain('Connecting voice')
    expect(renderComms('connecting', [])).not.toContain('Waiting for reply')
    expect(renderComms('thinking', [])).toContain('Waiting for reply')
    expect(renderComms('thinking', [])).not.toContain('Connecting voice')
  })

  it('does not stay transmitting after stop leaves a leftover pending review', () => {
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
      mcpCalls: emptyMcpCallLog,
      mcpFlash: null,
      onToggleMcpCall: () => {},
      inputSession: 'chat',
      selectedModel: fallbackChatModelCatalog.defaultModel,
      voice: stubVoice({
        phase: 'off',
        active: false,
        pendingReview: true,
        captions: [caption('a', 'make a clip'), caption('b', 'review on screen', 'assistant')],
        message: 'Comms off.',
      }),
      onEnsureCatalog: async () => undefined,
      onExecute: async () => ({ ok: true, message: 'Done' }),
      onModelChange: () => undefined,
      onSuccessfulExecute: () => undefined,
    }))
    expect(html).not.toContain('aria-busy="true"')
    expect(html).not.toContain('command-line-shell-transmitting')
    expect(html).not.toContain('Preparing an action')
  })
})
