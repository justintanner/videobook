import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Bot,
  Check,
  ChevronDown,
  Send,
  X,
} from 'lucide-react'
import type { ServerCommand } from '@/lib/command-registry'
import {
  applyNotebookMentionSuggestion,
  notebookAddressSuggestions,
  type NotebookAddressCell,
  type NotebookAddressSuggestion,
} from '@/videobook/mention-suggestions'
import { applyReadlineEdit } from '@/videobook/readline'
import {
  commandSuggestionCandidates,
  hasExactCommandSuggestion,
} from '@/videobook/command-suggestions'
import { composerInputAfterOutcome } from '@/videobook/command-composer-outcome'
import {
  commandHistoryPage,
  navigateCommandHistory,
} from '@/videobook/command-history'
import type { ChatModelOption } from '@/videobook/chat-models'
import {
  mcpToolLabel,
  type McpActivity,
} from '@/videobook/mcp-activity'
import {
  handleSpeakPreviewKey,
  isSpeakCommandPreview,
  persistSpeakVoiceId,
  readStoredSpeakVoiceId,
  resolveSpeakVoiceId,
  speakExecuteContext,
} from '@/videobook/speak-preview'
import { useVoicePreviewPlayer } from '@/videobook/voice-preview-player'
import type { ElevenLabsVoicesState } from '@/videobook/use-elevenlabs-voices'
import { SpeakCommandPreview } from '@/components/videobook/SpeakCommandPreview'

export interface ComposerOutcome {
  ok: boolean
  message: string
  nextInput?: string
  selectInput?: boolean
}

export interface ComposerNotice {
  message: string
  tone: 'error' | 'info'
}

export const COMMAND_COMPOSER_FORM_ID = 'videobook-command-composer-form'

interface CommandComposerProps {
  children?: ReactNode
  commands: ServerCommand[]
  cells: readonly NotebookAddressCell[]
  bookId: string
  callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>
  chatModels: readonly ChatModelOption[]
  disabled: boolean
  modelSelectionDisabled: boolean
  connectionLabel: string
  mcpActivity: McpActivity
  selectedModel: string
  pendingInput?: string
  notice?: ComposerNotice | null
  onEnsureCatalog: () => Promise<void>
  onDismissNotice?: () => void
  onDismissPanel?: () => void
  onExecute: (
    input: string,
    context?: { speakVoiceId?: string },
  ) => Promise<ComposerOutcome>
  onModelChange: (model: string) => void
  onSuccessfulExecute: () => void
  voiceCatalog?: ElevenLabsVoicesState
}

interface CommandSuggestion {
  value: string
  label: string
  description: string
  type: 'command'
}

type Suggestion = CommandSuggestion | NotebookAddressSuggestion

const COMMAND_HISTORY_PAGE_SIZE = 250

export function CommandComposer({
  children,
  commands,
  cells,
  bookId,
  callTool,
  chatModels,
  disabled,
  modelSelectionDisabled,
  connectionLabel,
  mcpActivity,
  selectedModel,
  pendingInput,
  notice,
  onEnsureCatalog,
  onDismissNotice,
  onDismissPanel,
  onExecute,
  onModelChange,
  onSuccessfulExecute,
  voiceCatalog,
}: CommandComposerProps) {
  const [input, setInput] = useState(pendingInput ?? '')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dismissed, setDismissed] = useState(
    () => pendingInput !== undefined && !isSpeakCommandPreview(pendingInput),
  )
  const [selectedVoiceId, setSelectedVoiceId] = useState(
    () => readStoredSpeakVoiceId() ?? '',
  )
  const previewPlayer = useVoicePreviewPlayer()
  const [sending, setSending] = useState(false)
  const [outcome, setOutcome] = useState<ComposerOutcome | null>(null)
  const [renderedPendingInput, setRenderedPendingInput] = useState(pendingInput)
  const inputRef = useRef<HTMLInputElement>(null)
  const killBufferRef = useRef('')
  const historyRef = useRef<string[]>([])
  const historyCursorRef = useRef(-1)
  const historyDraftRef = useRef('')
  const loadedHistoryProjectRef = useRef('')
  const historyLoadRef = useRef<{
    bookId: string
    promise: Promise<void>
  } | null>(null)
  const successTimerRef = useRef(0)
  const transmitting = sending || mcpActivity.phase === 'active'
  const mcpSucceeded = !transmitting && mcpActivity.phase === 'success'
  const mcpFailed = !transmitting && mcpActivity.phase === 'error'
  const selectedModelOption = chatModels.find((model) => model.id === selectedModel)
    ?? chatModels[0]

  if (pendingInput !== renderedPendingInput) {
    setRenderedPendingInput(pendingInput)
    setInput(pendingInput ?? '')
    setDismissed(pendingInput !== undefined && !isSpeakCommandPreview(pendingInput))
  }

  const speakPreviewOpen = !dismissed && isSpeakCommandPreview(input)
  const catalogVoices = voiceCatalog?.voices ?? []
  const activeVoiceId = resolveSpeakVoiceId(catalogVoices, selectedVoiceId)
  const refreshVoices = voiceCatalog?.refresh
  const stopPreview = previewPlayer.stop

  useEffect(() => {
    if (!speakPreviewOpen) {
      stopPreview()
      return
    }
    void refreshVoices?.()
  }, [refreshVoices, speakPreviewOpen, stopPreview])

  const focusInput = (select = false) => {
    requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true })
      if (select) inputRef.current?.select()
    })
  }

  const suggestions = useMemo<Suggestion[]>(() => {
    if (dismissed || isSpeakCommandPreview(input)) return []
    if (pendingInput && /^\/(?:apply|cancel)(?:\s|$)/iu.test(input)) return []
    const commandMatch = input.match(/^\/([\w-]*)$/)
    if (commandMatch) {
      const filter = commandMatch[1].toLowerCase()
      return commandSuggestionCandidates(commands, filter)
        .map((command) => ({
          value: `${command.command} `,
          label: command.command,
          description: command.description,
          type: 'command',
        }))
    }
    return notebookAddressSuggestions(cells, input)
  }, [cells, commands, dismissed, input, pendingInput])

  const showOutcome = (next: ComposerOutcome) => {
    window.clearTimeout(successTimerRef.current)
    setOutcome(next)
    if (next.ok) {
      successTimerRef.current = window.setTimeout(() => setOutcome(null), 3200)
    }
  }

  const loadHistory = async (targetBookId: string): Promise<string[]> => {
    const newestFirst: string[] = []
    let offset = 0
    while (true) {
      const result = await callTool('list_prompt_history', {
        book_id: targetBookId,
        surface: 'chat',
        limit: COMMAND_HISTORY_PAGE_SIZE,
        offset,
      })
      const page = commandHistoryPage(result)
      newestFirst.push(...page.values)
      if (!page.hasMore) return newestFirst.reverse()
      const nextOffset = page.offset + page.values.length
      if (nextOffset <= offset) {
        throw new Error('Prompt history pagination did not advance')
      }
      offset = nextOffset
    }
  }

  const ensureHistory = async (): Promise<void> => {
    const targetBookId = bookId
    if (!targetBookId) return
    const activeLoad = historyLoadRef.current
    if (activeLoad?.bookId === targetBookId) {
      await activeLoad.promise
      return
    }
    if (loadedHistoryProjectRef.current === targetBookId) return
    loadedHistoryProjectRef.current = targetBookId
    historyRef.current = []
    historyCursorRef.current = -1
    historyDraftRef.current = ''
    const promise = (async () => {
      try {
        const history = await loadHistory(targetBookId)
        if (loadedHistoryProjectRef.current === targetBookId) {
          historyRef.current = history
        }
      } catch {
        if (loadedHistoryProjectRef.current === targetBookId) {
          loadedHistoryProjectRef.current = ''
        }
      }
    })()
    historyLoadRef.current = { bookId: targetBookId, promise }
    await promise
    if (historyLoadRef.current?.promise === promise) {
      historyLoadRef.current = null
    }
  }

  const focusAndLoad = () => {
    void onEnsureCatalog().catch(() => undefined)
    void ensureHistory()
  }

  const recordHistory = (message: string) => {
    historyRef.current = [...historyRef.current, message]
    historyCursorRef.current = -1
    if (!bookId) return
    void callTool('record_prompt', {
      book_id: bookId,
      surface: 'chat',
      prompt: message,
      params: { model: selectedModel },
    }).catch(() => undefined)
  }

  const execute = async () => {
    const message = input.trim()
    if (!message || sending || disabled) return
    setSending(true)
    await ensureHistory()
    recordHistory(message)
    setInput('')
    setDismissed(false)
    let selectInput = false
    try {
      const voiceContext = speakExecuteContext(message, activeVoiceId)
      if (voiceContext?.speakVoiceId) persistSpeakVoiceId(voiceContext.speakVoiceId)
      const nextOutcome = await onExecute(message, voiceContext)
      showOutcome(nextOutcome)
      const inputDecision = composerInputAfterOutcome(nextOutcome, pendingInput)
      if (inputDecision) {
        setInput(inputDecision.value)
        setDismissed(!isSpeakCommandPreview(inputDecision.value))
        selectInput = inputDecision.select
      }
      if (nextOutcome.ok) onSuccessfulExecute()
    } catch (error) {
      showOutcome({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
      if (pendingInput !== undefined) {
        setInput(pendingInput)
        setDismissed(true)
        selectInput = true
      }
    } finally {
      setSending(false)
      focusInput(selectInput)
    }
  }

  const acceptSuggestion = (suggestion: Suggestion) => {
    if (suggestion.type === 'command') {
      setInput(suggestion.value)
      setDismissed(!isSpeakCommandPreview(suggestion.value))
    } else {
      setInput((current) =>
        `${applyNotebookMentionSuggestion(current, suggestion.value)} `)
      setDismissed(true)
    }
    historyCursorRef.current = -1
    focusInput()
  }

  const selectVoice = (voiceId: string) => {
    setSelectedVoiceId(voiceId)
    persistSpeakVoiceId(voiceId)
    if (previewPlayer.playingVoiceId && previewPlayer.playingVoiceId !== voiceId) {
      previewPlayer.stop()
    }
  }

  const toggleSelectedPreview = () => {
    const voice = catalogVoices.find((entry) => entry.voiceId === activeVoiceId)
    if (!voice?.previewUrl) return
    previewPlayer.toggle(voice.voiceId, voice.previewUrl)
  }

  const navigateHistory = async (direction: -1 | 1) => {
    await ensureHistory()
    const next = navigateCommandHistory({
      values: historyRef.current,
      cursor: historyCursorRef.current,
      draft: historyDraftRef.current,
      current: input,
      direction,
    })
    if (!next) return
    historyCursorRef.current = next.cursor
    historyDraftRef.current = next.draft
    setInput(next.value)
    setDismissed(true)
  }

  const applyInputReadline = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const target = event.currentTarget
    const edit = applyReadlineEdit({
      value: input,
      selectionStart: target.selectionStart ?? input.length,
      selectionEnd: target.selectionEnd ?? input.length,
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      yankText: killBufferRef.current,
      multiline: false,
    })
    if (!edit) return false
    event.preventDefault()
    setInput(edit.value)
    if (edit.killedText !== undefined) killBufferRef.current = edit.killedText
    requestAnimationFrame(() => target.setSelectionRange(
      edit.selectionStart,
      edit.selectionEnd,
    ))
    return true
  }

  return (
    <section className="command-composer">
      {notice && (
        <div
          className={`command-result ${notice.tone === 'error' ? 'command-result-error' : 'command-result-ok'}`}
          role={notice.tone === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {notice.tone === 'error' ? <X size={13} /> : <Check size={13} />}
          <span>{notice.message}</span>
          {onDismissNotice && (
            <button type="button" onClick={onDismissNotice} aria-label="Dismiss notice">
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {outcome && outcome.message !== notice?.message && (
        <div
          className={`command-result ${outcome.ok ? 'command-result-ok' : 'command-result-error'}`}
          role="status"
          aria-live="polite"
        >
          {outcome.ok ? <Check size={13} /> : <X size={13} />}
          <span>{outcome.message}</span>
          {!outcome.ok && (
            <button type="button" onClick={() => setOutcome(null)} aria-label="Dismiss error">
              <X size={12} />
            </button>
          )}
        </div>
      )}

      {children}

      {mcpActivity.phase !== 'idle' && (
        <div
          className={`mcp-activity mcp-activity-${mcpActivity.phase}`}
          data-testid="mcp-activity"
          role="status"
          aria-live="polite"
        >
          <span className="mcp-activity-signal" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="mcp-activity-copy">
            <strong>MCP</strong>
            <span>{mcpToolLabel(mcpActivity.tool)}</span>
          </span>
          <span className="mcp-activity-state">
            {mcpActivity.phase === 'active'
              ? mcpActivity.count > 1
                ? `${mcpActivity.count} calls`
                : 'working'
              : mcpActivity.phase === 'success'
                ? 'complete'
                : 'failed'}
          </span>
        </div>
      )}

      <form
        id={COMMAND_COMPOSER_FORM_ID}
        className={`command-line-shell ${transmitting ? 'command-line-shell-transmitting' : ''} ${mcpSucceeded ? 'command-line-shell-success' : ''} ${mcpFailed ? 'command-line-shell-error' : ''}`}
        aria-busy={transmitting}
        onSubmit={(event) => {
          event.preventDefault()
          void execute()
        }}
      >
        {speakPreviewOpen && (
          <SpeakCommandPreview
            voices={catalogVoices}
            selectedVoiceId={activeVoiceId}
            playingVoiceId={previewPlayer.playingVoiceId}
            status={voiceCatalog?.status ?? 'fallback'}
            warning={voiceCatalog?.warning ?? null}
            loading={voiceCatalog?.loading ?? false}
            error={voiceCatalog?.error ?? null}
            onSelect={selectVoice}
            onTogglePreview={previewPlayer.toggle}
          />
        )}
        {!speakPreviewOpen && suggestions.length > 0 && (
          <div className="command-suggestions">
            {suggestions.map((suggestion, index) => (
              <button
                type="button"
                key={`${suggestion.type}:${suggestion.label}`}
                className={`${index === selectedIndex ? 'active ' : ''}command-command-suggestion`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => acceptSuggestion(suggestion)}
              >
                <strong>{suggestion.label}</strong>
                <span>{suggestion.description}</span>
              </button>
            ))}
          </div>
        )}
        <span className="command-chevron">›</span>
        <input
          ref={inputRef}
          value={input}
          disabled={disabled || sending}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={disabled ? connectionLabel : 'Type a message or /command…'}
          aria-label="Videobook command input"
          onFocus={focusAndLoad}
          onChange={(event) => {
            setInput(event.target.value)
            setDismissed(false)
            setSelectedIndex(0)
            historyCursorRef.current = -1
          }}
          onKeyDown={(event) => {
            if (speakPreviewOpen) {
              const action = handleSpeakPreviewKey(event, catalogVoices, activeVoiceId)
              if (action.type !== 'ignore') event.preventDefault()
              if (action.type === 'select') {
                selectVoice(action.voiceId)
                return
              }
              if (action.type === 'toggle') {
                toggleSelectedPreview()
                return
              }
              if (action.type === 'dismiss') {
                previewPlayer.stop()
                setDismissed(true)
                return
              }
            }
            if (suggestions.length > 0) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSelectedIndex((index) => (index + 1) % suggestions.length)
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelectedIndex((index) => (
                  index - 1 + suggestions.length
                ) % suggestions.length)
                return
              }
              if (event.key === 'Tab') {
                event.preventDefault()
                acceptSuggestion(suggestions[selectedIndex]!)
                return
              }
              if (event.key === 'Enter') {
                const exact = hasExactCommandSuggestion(input, suggestions)
                if (!exact) {
                  event.preventDefault()
                  acceptSuggestion(suggestions[selectedIndex]!)
                  return
                }
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setDismissed(true)
                return
              }
            }
            if (event.key === 'Escape' && onDismissPanel) {
              event.preventDefault()
              onDismissPanel()
              return
            }
            if (event.ctrlKey && event.key.toLowerCase() === 'p') {
              event.preventDefault()
              void navigateHistory(-1)
              return
            }
            if (event.ctrlKey && event.key.toLowerCase() === 'n') {
              event.preventDefault()
              void navigateHistory(1)
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              void navigateHistory(-1)
              return
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              void navigateHistory(1)
              return
            }
            if (applyInputReadline(event)) return
            if (event.key === 'Enter') {
              event.preventDefault()
              void execute()
            }
          }}
        />
        <label
          className="command-model-selector"
          title={selectedModelOption?.description}
        >
          <Bot size={13} aria-hidden="true" />
          <select
            value={selectedModel}
            disabled={modelSelectionDisabled || sending}
            aria-label="Chat model"
            data-testid="chat-model-selector"
            onChange={(event) => onModelChange(event.target.value)}
          >
            {chatModels.map((model) => (
              <option key={model.id} value={model.id}>{model.id}</option>
            ))}
          </select>
          <ChevronDown size={12} aria-hidden="true" />
        </label>
        <button
          type="submit"
          className="command-send"
          disabled={disabled || sending || !input.trim()}
          aria-label="Send command"
        >
          {sending
            ? <span className="command-send-working" aria-hidden="true" />
            : <Send size={16} />}
        </button>
        {transmitting && <span className="command-transmit-scan" aria-hidden="true" />}
      </form>
    </section>
  )
}
