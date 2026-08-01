import { useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AudioWaveform,
  Check,
  ChevronUp,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  Send,
  X,
} from 'lucide-react'
import type { UseMcpResult } from 'use-mcp/react'
import type { ServerCommand } from '@/lib/command-registry'
import { RichPromptField } from '@/components/ui/RichPromptField'
import { MediaLibraryAssetPreview } from './MediaLibraryAssetPreview'
import {
  assetMentionMetadata,
  assetMentionSuggestions,
  type AssetMentionCandidate,
  type AssetMentionSuggestion,
} from '@/videobook/mention-suggestions'
import { applyReadlineEdit } from '@/videobook/readline'
import {
  commandSuggestionCandidates,
  hasExactCommandSuggestion,
} from '@/videobook/command-suggestions'
import { composerInputAfterOutcome } from '@/videobook/command-composer-outcome'

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

export interface PromptSession {
  id: string
  kind: string
  slug: string
  value: string
  assetSlugs: string[]
  onChange: (value: string) => void
  onCommit: () => Promise<ComposerOutcome>
  onCollapse: () => Promise<ComposerOutcome>
}

interface CommandComposerProps {
  children?: ReactNode
  commands: ServerCommand[]
  assets: readonly AssetMentionCandidate[]
  bookId: string
  callTool: UseMcpResult['callTool']
  disabled: boolean
  connectionLabel: string
  promptSession: PromptSession | null
  pendingInput?: string
  notice?: ComposerNotice | null
  onEnsureCatalog: () => Promise<void>
  onDismissNotice?: () => void
  onDismissPanel?: () => void
  onExecute: (input: string) => Promise<ComposerOutcome>
  onSuccessfulExecute: () => void
}

interface CommandSuggestion {
  value: string
  label: string
  description: string
  type: 'command'
}

type Suggestion = CommandSuggestion | AssetMentionSuggestion

interface PromptHistoryEntry {
  prompt: string
}

function resultText(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    return null
  }
  const content = result.content
  if (!Array.isArray(content)) return null
  const item = content.find((candidate) => (
    typeof candidate === 'object'
    && candidate !== null
    && 'type' in candidate
    && candidate.type === 'text'
    && 'text' in candidate
    && typeof candidate.text === 'string'
  ))
  return item && 'text' in item ? item.text as string : null
}

function historyPayload(value: unknown): string[] {
  const text = resultText(value)
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as { entries?: PromptHistoryEntry[] }
    return (parsed.entries ?? []).map((entry) => entry.prompt).reverse()
  } catch {
    return []
  }
}

export function CommandComposer({
  children,
  commands,
  assets,
  bookId,
  callTool,
  disabled,
  connectionLabel,
  promptSession,
  pendingInput,
  notice,
  onEnsureCatalog,
  onDismissNotice,
  onDismissPanel,
  onExecute,
  onSuccessfulExecute,
}: CommandComposerProps) {
  const [input, setInput] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [sending, setSending] = useState(false)
  const [outcome, setOutcome] = useState<ComposerOutcome | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const killBufferRef = useRef('')
  const historyRef = useRef<string[]>([])
  const historyCursorRef = useRef(-1)
  const historyDraftRef = useRef('')
  const loadedHistoryProjectRef = useRef('')
  const successTimerRef = useRef(0)

  const focusInput = (select = false) => {
    requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true })
      if (select) inputRef.current?.select()
    })
  }

  const suggestions = useMemo<Suggestion[]>(() => {
    if (dismissed) return []
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
    return assetMentionSuggestions(assets, input)
  }, [assets, commands, dismissed, input, pendingInput])

  const showOutcome = (next: ComposerOutcome) => {
    window.clearTimeout(successTimerRef.current)
    setOutcome(next)
    if (next.ok) {
      successTimerRef.current = window.setTimeout(() => setOutcome(null), 3200)
    }
  }

  const ensureHistory = async () => {
    if (!bookId || loadedHistoryProjectRef.current === bookId) return
    loadedHistoryProjectRef.current = bookId
    historyRef.current = []
    historyCursorRef.current = -1
    try {
      const result = await callTool('list_prompt_history', {
        book_id: bookId,
        surface: 'chat',
        limit: 100,
      })
      historyRef.current = historyPayload(result)
    } catch {
      loadedHistoryProjectRef.current = ''
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
    }).catch(() => undefined)
  }

  const execute = async () => {
    const message = input.trim()
    if (!message || sending || disabled) return
    recordHistory(message)
    setInput('')
    setDismissed(false)
    setSending(true)
    let selectInput = false
    try {
      const nextOutcome = await onExecute(message)
      showOutcome(nextOutcome)
      const inputDecision = composerInputAfterOutcome(nextOutcome, pendingInput)
      if (inputDecision) {
        setInput(inputDecision.value)
        setDismissed(true)
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
    } else {
      setInput((current) => current.replace(/@[\w-]*$/, suggestion.value) + ' ')
    }
    setDismissed(true)
    focusInput()
  }

  const navigateHistory = (direction: -1 | 1) => {
    const values = historyRef.current
    if (values.length === 0) return
    if (historyCursorRef.current === -1) {
      if (direction === 1) return
      historyDraftRef.current = input
      historyCursorRef.current = values.length - 1
    } else {
      historyCursorRef.current += direction
      if (historyCursorRef.current < 0) historyCursorRef.current = 0
      if (historyCursorRef.current >= values.length) {
        historyCursorRef.current = -1
        setInput(historyDraftRef.current)
        return
      }
    }
    setInput(values[historyCursorRef.current] ?? '')
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

  const applyPromptReadline = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (!promptSession) return false
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      void promptSession.onCommit().then(showOutcome)
      focusInput()
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      void promptSession.onCollapse().then(showOutcome)
      focusInput()
      return true
    }
    const target = event.currentTarget
    const edit = applyReadlineEdit({
      value: promptSession.value,
      selectionStart: target.selectionStart,
      selectionEnd: target.selectionEnd,
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      yankText: killBufferRef.current,
      multiline: true,
    })
    if (!edit) return false
    event.preventDefault()
    promptSession.onChange(edit.value)
    if (edit.killedText !== undefined) killBufferRef.current = edit.killedText
    requestAnimationFrame(() => target.setSelectionRange(
      edit.selectionStart,
      edit.selectionEnd,
    ))
    return true
  }

  return (
    <section className={`command-composer ${promptSession ? 'command-composer-expanded' : ''}`}>
      {promptSession && (
        <div className="prompt-drawer">
          <header>
            <span>
              {promptSession.kind === 'prompt'
                ? 'note cell'
                : `${promptSession.kind} prompt`}
            </span>
            <strong>{promptSession.slug}</strong>
            <button
              type="button"
              onClick={() => void promptSession.onCollapse().then(showOutcome)}
              aria-label="Commit and collapse prompt editor"
            >
              <ChevronUp size={15} />
            </button>
          </header>
          <RichPromptField
            value={promptSession.value}
            onChange={promptSession.onChange}
            resolveRef={() => null}
            assetSlugs={promptSession.assetSlugs}
            rows={7}
            autoFocus
            placeholder="Describe the desired result or reference reusable context…"
            onKeyDownExtra={applyPromptReadline}
            fieldClassName="w-full px-4 py-3 font-mono text-[13px] leading-6"
            surfaceClassName="prompt-drawer-field"
            textClassName="text-[#b9dfcb]"
            caretClassName="caret-[#72e7aa]"
          />
        </div>
      )}

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

      <form
        id={COMMAND_COMPOSER_FORM_ID}
        className="command-line-shell"
        onSubmit={(event) => {
          event.preventDefault()
          void execute()
        }}
      >
        {suggestions.length > 0 && (
          <div className="command-suggestions">
            {suggestions.map((suggestion, index) => (
              <button
                type="button"
                key={suggestion.label}
                className={`${index === selectedIndex ? 'active ' : ''}${
                  suggestion.type === 'asset'
                    ? 'command-asset-suggestion'
                    : 'command-command-suggestion'
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => acceptSuggestion(suggestion)}
              >
                {suggestion.type === 'asset' ? (
                  <>
                    <span className="command-asset-preview" aria-hidden="true">
                      <AssetSuggestionPreview asset={suggestion.asset} />
                    </span>
                    <span className="command-asset-copy">
                      <strong>{suggestion.label}</strong>
                      <span className="command-asset-metadata">
                        {assetMentionMetadata(suggestion.asset).map((item, itemIndex) => (
                          <span key={`${item}-${itemIndex}`}>{item}</span>
                        ))}
                      </span>
                    </span>
                  </>
                ) : (
                  <>
                    <strong>{suggestion.label}</strong>
                    <span>{suggestion.description}</span>
                  </>
                )}
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
              navigateHistory(-1)
              return
            }
            if (event.ctrlKey && event.key.toLowerCase() === 'n') {
              event.preventDefault()
              navigateHistory(1)
              return
            }
            if (applyInputReadline(event)) return
            if (event.key === 'Enter') {
              event.preventDefault()
              void execute()
            }
          }}
        />
        <button
          type="submit"
          className="command-send"
          disabled={disabled || sending || !input.trim()}
          aria-label="Send command"
        >
          {sending ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
        </button>
      </form>
    </section>
  )
}

function AssetSuggestionPreview({
  asset,
}: {
  asset: AssetMentionCandidate
}) {
  const visual = Boolean(
    asset.thumbnailUrl
    || (
      asset.mediaUrl
      && (
        asset.type === 'image'
        || asset.type === 'video'
        || asset.type === 'final'
      )
    ),
  )
  if (visual) return <MediaLibraryAssetPreview asset={asset} eager />
  if (asset.type === 'audio') return <AudioWaveform size={17} />
  if (asset.type === 'image') return <ImageIcon size={17} />
  if (asset.type === 'video' || asset.type === 'final') return <Film size={17} />
  return <FileText size={17} />
}
