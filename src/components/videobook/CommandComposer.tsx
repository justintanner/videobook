import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  ListFilter,
  Send,
} from 'lucide-react'
import { createPortal } from 'react-dom'
import { ComposerDockClose } from './ComposerDockClose'
import { ComposerHistory, ComposerHistoryControls } from './ComposerHistory'
import {
  ComposerHistoryChromeContext,
  type ComposerHistoryChromeValue,
} from './composer-history-chrome'
import { ComposerStatusLine } from './ComposerStatusLine'
import type { ServerCommand } from '@/lib/command-registry'
import type { AssetMentionCandidate } from '@/videobook/mention-suggestions'
import { composerReferenceDescription, composerReferenceSuggestions, replaceComposerMention, type ComposerReference } from '@/videobook/composer-references'
import type { ComposerSelection } from '@/videobook/composer-editor-model'
import type { EditorState } from 'prosemirror-state'
import type { WorkspaceAction } from '../../../server/src/workspace-action-contract'
import { searchWorkspaceActions, type WorkspaceActionContext } from '@/videobook/workspace-actions'
import { RichComposerEditor, type ComposerEditorHandle } from './RichComposerEditor'
import { ComposerActionsPanel } from './ComposerActionsPanel'
import { ArtifactThumb } from './ArtifactThumb'
import './CommandComposer.css'
import { applyReadlineEdit } from '@/videobook/readline'
import {
  commandSuggestionCandidates,
  hasExactCommandSuggestion,
} from '@/videobook/command-suggestions'
import { composerInputAfterOutcome } from '@/videobook/command-composer-outcome'
import { captureCommandComposerFocus } from '@/videobook/command-composer-focus'
import {
  commandHistoryPage,
  navigateCommandHistory,
} from '@/videobook/command-history'
import type { ChatModelOption } from '@/videobook/chat-models'
import {
  mcpCallsRunning,
  type McpCallLog,
  type McpFlash,
} from '@/videobook/mcp-activity'
import {
  composerHistory,
  composerHistoryEpoch,
  composerHistoryGeneration,
  historyAutoCloseHeld,
  historyIdle,
  scheduleHistoryAutoClose,
} from '@/videobook/composer-history'
import { composerActivityStatus } from '@/videobook/composer-status'
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
import { BusyIndicator } from '@/components/videobook/BusyIndicator'
import {
  ComposerDockContext,
  type ComposerDockControls,
} from '@/components/videobook/composer-dock-context'
import {
  ComposerOutcomeContext,
  type ComposerOutcomeSlot,
} from '@/components/videobook/composer-outcome-context'
import { SpeakCommandPreview } from '@/components/videobook/SpeakCommandPreview'
import { VoiceComms } from './VoiceComms'
import { ComposerModeSwitch } from './ComposerModeSwitch'
import type { VoiceConversation } from '@/videobook/use-voice-conversation'
import {
  COMPOSER_DOCK_HIDE_LABEL,
  composerDockCloseInPanel,
  composerDockNoticeInHeader,
  composerDockReviewPriority,
  composerHistoryChromeHosted,
  hideComposerDock,
  pauseComposerDockMedia,
} from '@/videobook/composer-dock'

export interface ComposerOutcome {
  ok: boolean
  message: string
  nextInput?: string
  selectInput?: boolean
}

interface ComposerNotice {
  message: string
  tone: 'error' | 'info'
}

export const COMMAND_COMPOSER_FORM_ID = 'videobook-command-composer-form'

export interface ComposerActionDiscovery {
  key: number
  query: string
  values?: Record<string, unknown>
}

export interface ComposerExecuteContext {
  speakVoiceId?: string
  action?: { id: string; values?: Record<string, unknown> }
}

interface CommandComposerProps {
  children?: ReactNode
  commands: ServerCommand[]
  references: ReadonlyMap<string, ComposerReference>
  actions: readonly WorkspaceAction[]
  actionContext: WorkspaceActionContext
  actionDiscovery: ComposerActionDiscovery | null
  actionStatus: { loading: boolean; error: string | null }
  actionsDisabled: boolean
  onOpenActions: () => void
  onCloseActionSearch: (prepared: boolean) => void
  onDismissComposer?: () => void
  dockOpen?: boolean
  onDockOpenChange?: (open: boolean) => void
  contextualContent?: ReactNode
  contextualHasHeader?: boolean
  bookId: string
  callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>
  chatModels: readonly ChatModelOption[]
  disabled: boolean
  hidden?: boolean
  modelSelectionDisabled: boolean
  connectionLabel: string
  mcpCalls: McpCallLog
  mcpFlash: McpFlash
  onToggleMcpCall: (id: number) => void
  selectedModel: string
  context?: {
    description: string
    label: string
  } | null
  mentionAssets?: readonly AssetMentionCandidate[]
  inputSession?: string | null
  placeholder?: string
  portalTarget?: Element | null
  pendingInput?: string
  notice?: ComposerNotice | null
  // Where execute outcomes and the notice render: the composer's own result
  // strip, or the footer of the confirm sheet passed as children.
  outcomeSlot?: 'composer' | 'sheet'
  onEnsureCatalog: () => Promise<void>
  onDismissNotice?: () => void
  onDismissPanel?: () => void
  onExecute: (
    input: string,
    context?: ComposerExecuteContext,
  ) => Promise<ComposerOutcome>
  onModelChange: (model: string) => void
  onStartVoice?: () => void
  onSendingChange?: (sending: boolean) => void
  onCommandRowHeightChange?: (height: number) => void
  onSuccessfulExecute: () => void
  voiceCatalog?: ElevenLabsVoicesState
  voice?: VoiceConversation
}

interface CommandSuggestion {
  value: string
  label: string
  description: string
  aliases?: readonly string[]
  type: 'command'
}

type Suggestion = CommandSuggestion | {
  value: string
  label: string
  description: string
  type: 'cell'
  reference: ComposerReference
}

const COMMAND_HISTORY_PAGE_SIZE = 250

export function CommandComposer({
  children,
  commands,
  references,
  actions,
  actionContext,
  actionDiscovery,
  actionStatus,
  actionsDisabled,
  onOpenActions,
  onCloseActionSearch,
  onDismissComposer,
  dockOpen,
  onDockOpenChange,
  contextualContent = null,
  contextualHasHeader = false,
  bookId,
  callTool,
  chatModels,
  disabled,
  hidden = false,
  modelSelectionDisabled,
  connectionLabel,
  mcpCalls,
  mcpFlash,
  onToggleMcpCall,
  selectedModel,
  context = null,
  mentionAssets = [],
  inputSession = null,
  placeholder,
  portalTarget = null,
  pendingInput,
  notice,
  outcomeSlot = 'composer',
  onEnsureCatalog,
  onDismissNotice,
  onDismissPanel,
  onExecute,
  onModelChange,
  onStartVoice,
  onSendingChange,
  onCommandRowHeightChange,
  onSuccessfulExecute,
  voiceCatalog,
  voice,
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
  const [voiceReviewDraft, setVoiceReviewDraft] = useState(false)
  const [renderedInputSession, setRenderedInputSession] = useState(inputSession)
  const [inputDrafts, setInputDrafts] = useState<ReadonlyMap<string | null, string>>(
    () => new Map(),
  )
  const inputRef = useRef<ComposerEditorHandle>(null)
  const composerRootRef = useRef<HTMLElement | null>(null)
  const commandRowRef = useRef<HTMLFormElement | null>(null)

  useLayoutEffect(() => {
    const row = commandRowRef.current
    const root = composerRootRef.current
    if (hidden || portalTarget || !row || !root || !onCommandRowHeightChange) return
    const sync = () => {
      const style = getComputedStyle(root)
      onCommandRowHeightChange(row.getBoundingClientRect().height
        + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth))
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(row)
    return () => observer.disconnect()
  }, [hidden, onCommandRowHeightChange, portalTarget])
  const [uncontrolledDockOpen, setUncontrolledDockOpen] = useState(false)
  const dockRequestedOpen = dockOpen ?? uncontrolledDockOpen
  const dockWasOpenRef = useRef(dockRequestedOpen)
  const setDockOpen = (open: boolean) => {
    if (dockOpen === undefined) setUncontrolledDockOpen(open)
    onDockOpenChange?.(open)
  }
  const [editorSessions] = useState(() => new Map<string, EditorState>())
  const [selection, setSelection] = useState<ComposerSelection>({ start: input.length, end: input.length })
  const [actionQuery, setActionQuery] = useState(actionDiscovery?.query ?? '')
  const [actionGroup, setActionGroup] = useState('')
  const [renderedActionKey, setRenderedActionKey] = useState(actionDiscovery?.key)
  const [preparedAction, setPreparedAction] = useState<{ action: WorkspaceAction; values?: Record<string, unknown> } | null>(null)
  const suggestionId = useId()
  const historyCaptionId = useId()
  const inputSessionRef = useRef(inputSession)
  const killBufferRef = useRef('')
  const historyRef = useRef<string[]>([])
  const historyCursorRef = useRef(-1)
  const historyDraftRef = useRef('')
  const loadedHistoryProjectRef = useRef('')
  const latestVoiceTurn = voice?.captions.filter(caption => caption.role === 'user' && caption.final).at(-1)?.id
  const loadedCatalogProjectRef = useRef<string | null>(null)
  const composingRef = useRef(false)
  const historyLoadRef = useRef<{
    bookId: string
    promise: Promise<void>
  } | null>(null)
  const successTimerRef = useRef(0)
  const [historyOpen, setHistoryOpen] = useState(true)
  const [voiceStartHistoryEpoch, setVoiceStartHistoryEpoch] = useState(0)
  const historyRows = useMemo(
    () => composerHistory(voice?.captions ?? [], mcpCalls),
    [mcpCalls, voice?.captions],
  )
  const historyEpoch = composerHistoryEpoch(historyRows)
  const historyGeneration = composerHistoryGeneration(historyRows)
  const activity = composerActivityStatus({
    sending,
    mcpRunning: mcpCallsRunning(mcpCalls),
    voicePhase: voice?.phase,
    voiceMessage: voice?.message,
    retrying: voice?.retrying,
    pendingReview: voice?.pendingReview,
  })
  const transmitting = activity.busy && activity.kind !== 'connecting' && activity.kind !== 'permission'
  const mcpSucceeded = !transmitting && mcpFlash === 'success'
  const mcpFailed = !transmitting && mcpFlash === 'error'
  const historyHeld = historyAutoCloseHeld({
    runningCalls: mcpCallsRunning(mcpCalls),
    voicePhase: voice?.phase,
  }) || mcpCalls.calls.some((call) => call.expanded)
  const lastHistoryEpochRef = useRef(historyEpoch)

  useLayoutEffect(() => {
    inputSessionRef.current = inputSession
  }, [inputSession])

  useEffect(() => {
    if (historyEpoch > lastHistoryEpochRef.current) setHistoryOpen(true)
    lastHistoryEpochRef.current = historyEpoch
  }, [historyEpoch])

  useEffect(() => scheduleHistoryAutoClose({
    open: historyOpen,
    held: historyHeld,
    onClose: () => setHistoryOpen(false),
  }), [historyOpen, historyHeld, historyGeneration])

  useLayoutEffect(() => { if (latestVoiceTurn) loadedHistoryProjectRef.current = '' }, [latestVoiceTurn])

  useEffect(() => {
    window.clearTimeout(successTimerRef.current)
  }, [inputSession])

  if (inputSession !== renderedInputSession) {
    const nextDrafts = new Map(inputDrafts)
    nextDrafts.set(renderedInputSession, input)
    setInputDrafts(nextDrafts)
    setRenderedInputSession(inputSession)
    setRenderedPendingInput(pendingInput)
    setVoiceReviewDraft(false)
    setInput(pendingInput ?? nextDrafts.get(inputSession) ?? '')
    setOutcome(null)
    setPreparedAction(null)
    setDismissed(pendingInput !== undefined && !isSpeakCommandPreview(pendingInput))
  } else if (pendingInput !== renderedPendingInput) {
    setRenderedPendingInput(pendingInput)
    if (voice?.pendingReview || voiceReviewDraft) {
      setVoiceReviewDraft(pendingInput !== undefined)
    } else setInput(pendingInput ?? '')
    setDismissed(pendingInput !== undefined && !isSpeakCommandPreview(pendingInput))
  }

  if (actionDiscovery?.key !== renderedActionKey) {
    setRenderedActionKey(actionDiscovery?.key)
    setActionQuery(actionDiscovery?.query ?? '')
    setActionGroup('')
    setSelectedIndex(0)
  }

  const speakPreviewOpen = !actionDiscovery && !context && !dismissed && isSpeakCommandPreview(input)
  const voiceStatusOnly = voice?.active
    && !contextualContent
    && !children
    && !notice
    && !outcome
    && !actionDiscovery
    && !speakPreviewOpen
    && historyEpoch <= voiceStartHistoryEpoch
    && !(historyOpen && historyRows.length > 0)
    && !voice.playbackBlocked
  const dockIsOpen = dockRequestedOpen && !voiceStatusOnly
  const catalogVoices = voiceCatalog?.voices ?? []
  const activeVoiceId = resolveSpeakVoiceId(catalogVoices, selectedVoiceId)
  const stopPreview = previewPlayer.stop

  useEffect(() => {
    if (!speakPreviewOpen) stopPreview()
  }, [speakPreviewOpen, stopPreview])

  const ensureVoiceCatalog = () => {
    if (!voiceCatalog) return
    void voiceCatalog.ensureLoaded().catch(() => undefined)
  }

  const ensureVoicesForInput = (value: string) => {
    if (!context && isSpeakCommandPreview(value)) ensureVoiceCatalog()
  }

  const refreshVoiceCatalog = () => {
    if (!voiceCatalog) return
    void voiceCatalog.refresh().catch(() => undefined)
  }

  const focusInput = (select = false) => {
    captureCommandComposerFocus(
      () => inputRef.current?.element() ?? null,
      () => { if (select) inputRef.current?.select() },
    )()
  }

  const hideDock = () => {
    setDismissed(true)
    if (actionDiscovery) onCloseActionSearch(false)
    hideComposerDock({
      setOpen: setDockOpen,
      stopVoice: voice?.stop,
      pauseMedia: () => pauseComposerDockMedia(composerRootRef.current),
    })
    focusInput()
  }

  const toggleVoice = () => {
    if (!voice) return
    if (voice.active) {
      voice.stop()
      focusInput()
      return
    }
    if (voice.disabled || sending) return
    previewPlayer.stop()
    pauseComposerDockMedia(composerRootRef.current)
    setInput('')
    setSelection({ start: 0, end: 0 })
    setVoiceReviewDraft(false)
    setPreparedAction(null)
    setOutcome(null)
    setDismissed(true)
    setHistoryOpen(false)
    setVoiceStartHistoryEpoch(historyEpoch)
    historyCursorRef.current = -1
    historyDraftRef.current = ''
    if (actionDiscovery) onCloseActionSearch(false)
    onDismissNotice?.()
    onStartVoice?.()
    setDockOpen(true)
    voice.toggle()
    focusInput()
  }

  useEffect(() => {
    const wasOpen = dockWasOpenRef.current
    dockWasOpenRef.current = dockRequestedOpen
    if (!wasOpen || dockRequestedOpen) return
    previewPlayer.stop()
    voice?.stop()
    pauseComposerDockMedia(composerRootRef.current)
  }, [dockRequestedOpen, previewPlayer, voice])

  const outcomeSlotValue = useMemo<ComposerOutcomeSlot>(() => ({
    outcome,
    notice: notice ?? null,
    dismissOutcome: () => setOutcome(null),
    dismissNotice: () => onDismissNotice?.(),
  }), [notice, onDismissNotice, outcome])

  const suggestions = useMemo<Suggestion[]>(() => {
    if (actionDiscovery || dismissed || isSpeakCommandPreview(input)) return []
    if (pendingInput && /^\/(?:apply|cancel)(?:\s|$)/iu.test(input)) return []
    const commandMatch = input.match(/^\/([\w-]*)$/)
    if (commandMatch && !context) {
      const filter = commandMatch[1].toLowerCase()
      return commandSuggestionCandidates(commands, filter)
        .map((command) => ({
          value: `${command.command} `,
          label: command.command,
          description: command.description,
          aliases: command.aliases,
          type: 'command',
        }))
    }
    const allowed = context ? new Set(mentionAssets.map(asset => asset.artifactId)) : undefined
    return composerReferenceSuggestions(references, input, selection.start, selection.end, allowed).map(reference => ({
      value: reference.token,
      label: reference.token,
      description: composerReferenceDescription(reference),
      type: 'cell',
      reference,
    }))
  }, [actionDiscovery, commands, context, dismissed, input, mentionAssets, pendingInput, references, selection])

  const actionMatches = useMemo(() => searchWorkspaceActions(actions, actionQuery)
    .filter(action => !actionGroup || action.group === actionGroup), [actionGroup, actionQuery, actions])
  const actionGroups = useMemo(() => [...new Set(actions.map(action => action.group))].sort(), [actions])
  const activeActionIndex = Math.min(selectedIndex, Math.max(0, actionMatches.length - 1))
  const actionListId = `${suggestionId}-actions`
  const preparedCommandMatches = preparedAction?.action.command === input.trim().split(/\s/u)[0]
  const inputDisabled = preparedCommandMatches && preparedAction?.action.scope === 'global' ? actionsDisabled : disabled

  useLayoutEffect(() => {
    if (!actionDiscovery) return
    captureCommandComposerFocus(() => inputRef.current?.element() ?? null)()
  }, [actionDiscovery, portalTarget])

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
    if (!context) {
      if (loadedCatalogProjectRef.current !== bookId) {
        loadedCatalogProjectRef.current = bookId
        void onEnsureCatalog().catch(() => {
          if (loadedCatalogProjectRef.current === bookId) loadedCatalogProjectRef.current = null
        })
      }
      void ensureHistory()
    }
    if (speakPreviewOpen) ensureVoiceCatalog()
  }

  const recordHistory = async (message: string) => {
    historyRef.current = [...historyRef.current, message]
    historyCursorRef.current = -1
    if (!bookId) return
    await callTool('record_prompt', {
      book_id: bookId,
      surface: 'chat',
      prompt: message,
      params: { model: selectedModel },
    }).catch(() => undefined)
  }

  const execute = async (reviewCommand?: string) => {
    const preserveDraft = reviewCommand !== undefined
    const message = (reviewCommand ?? input).trim()
    if (!message || sending || inputDisabled || actionDiscovery || composingRef.current) return
    setDockOpen(true)
    if (!preserveDraft) setVoiceReviewDraft(false)
    const chosenAction = preparedAction?.action.command === message.split(/\s/u)[0] ? preparedAction : null
    const executionSession = inputSession
    setSending(true)
    onSendingChange?.(true)
    let selectInput = false
    const restoreFocus = captureCommandComposerFocus(
      () => inputRef.current?.element() ?? null,
      () => { if (selectInput) inputRef.current?.select() },
    )
    try {
      if (!context || chosenAction) {
        await ensureHistory()
        if (inputSessionRef.current !== executionSession) return
        await recordHistory(message)
      }
      if (inputSessionRef.current !== executionSession) return
      if (!preserveDraft) setInput('')
      setDismissed(false)
      const loadedVoiceCatalog = !context && isSpeakCommandPreview(message)
        ? await voiceCatalog?.ensureLoaded()
        : null
      if (inputSessionRef.current !== executionSession) return
      const voiceId = resolveSpeakVoiceId(
        loadedVoiceCatalog?.voices ?? catalogVoices,
        selectedVoiceId,
      )
      const voiceContext = speakExecuteContext(message, voiceId)
      if (voiceContext?.speakVoiceId) persistSpeakVoiceId(voiceContext.speakVoiceId)
      const nextOutcome = await onExecute(message, {
        ...voiceContext,
        ...(chosenAction ? { action: { id: chosenAction.action.id, values: chosenAction.values } } : {}),
      })
      if (inputSessionRef.current !== executionSession) return
      setPreparedAction(null)
      showOutcome(nextOutcome)
      const inputDecision = composerInputAfterOutcome(nextOutcome, pendingInput)
      if (inputDecision && !preserveDraft) {
        setInput(inputDecision.value)
        setDismissed(!isSpeakCommandPreview(inputDecision.value))
        ensureVoicesForInput(inputDecision.value)
        selectInput = inputDecision.select
      }
      if (nextOutcome.ok) onSuccessfulExecute()
    } catch (error) {
      if (inputSessionRef.current !== executionSession) return
      showOutcome({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
      if (pendingInput !== undefined && !preserveDraft) {
        setInput(pendingInput)
        setDismissed(true)
        selectInput = true
      }
    } finally {
      setSending(false)
      onSendingChange?.(false)
      if (inputSessionRef.current === executionSession) restoreFocus()
    }
  }

  const acceptSuggestion = (suggestion: Suggestion) => {
    if (suggestion.type === 'command') {
      inputRef.current?.replace(suggestion.value)
      setDismissed(!isSpeakCommandPreview(suggestion.value))
      ensureVoicesForInput(suggestion.value)
    } else {
      const current = inputRef.current?.selection() ?? selection
      const replacement = replaceComposerMention(input, suggestion.value, current.start, current.end)
      if (!replacement) return
      inputRef.current?.replace(replacement.value, { start: replacement.caret, end: replacement.caret })
      setDismissed(true)
    }
    historyCursorRef.current = -1
    focusInput()
  }

  const acceptAction = (action: WorkspaceAction) => {
    setPreparedAction({ action, values: actionDiscovery?.values })
    setInput(`${action.command} `)
    setDismissed(true)
    setSelectedIndex(0)
    onCloseActionSearch(true)
    focusInput()
  }

  const closeActionSearch = () => {
    onCloseActionSearch(false)
    if (!onDismissComposer) focusInput()
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
    const session = inputSession
    await ensureHistory()
    if (session !== inputSessionRef.current) return
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
    ensureVoicesForInput(next.value)
  }

  const applyInputReadline = (event: KeyboardEvent, value = input) => {
    const current = inputRef.current?.selection() ?? selection
    const edit = applyReadlineEdit({
      value,
      selectionStart: current.start,
      selectionEnd: current.end,
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      yankText: killBufferRef.current,
      multiline: false,
    })
    if (!edit) return false
    event.preventDefault()
    if (edit.value === value) inputRef.current?.setSelection({ start: edit.selectionStart, end: edit.selectionEnd })
    else inputRef.current?.replace(edit.value, { start: edit.selectionStart, end: edit.selectionEnd })
    ensureVoicesForInput(edit.value)
    if (edit.killedText !== undefined) killBufferRef.current = edit.killedText
    return true
  }

  const handleInputKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      const popover = document.querySelector<HTMLElement>('.mcp-call-popover:popover-open')
      if (popover) {
        event.preventDefault()
        event.stopPropagation()
        popover.hidePopover()
        return
      }
    }

    if (composingRef.current || event.isComposing || event.keyCode === 229) {
      if (event.key === 'Enter') event.preventDefault()
      return
    }
    if (actionDiscovery) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeActionSearch()
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? actionMatches.length - 1
          : (activeActionIndex + (event.key === 'ArrowDown' ? 1 : -1) + actionMatches.length) % Math.max(1, actionMatches.length)
        setSelectedIndex(Math.max(0, next))
        document.getElementById(`${actionListId}-option-${next}`)?.scrollIntoView({ block: 'nearest' })
      } else if ((event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) && actionMatches[activeActionIndex]) {
        event.preventDefault()
        acceptAction(actionMatches[activeActionIndex]!)
      } else applyInputReadline(event, actionQuery)
      return
    }
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
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? suggestions.length - 1
          : (selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length
        setSelectedIndex(next)
        document.getElementById(`${suggestionId}-option-${next}`)?.scrollIntoView({ block: 'nearest' })
        return
      }
      if (event.key === 'Tab' && !event.shiftKey) {
        event.preventDefault()
        acceptSuggestion(suggestions[Math.min(selectedIndex, suggestions.length - 1)]!)
        return
      }
      if (event.key === 'Enter') {
        const exact = hasExactCommandSuggestion(input, suggestions)
        if (!exact) {
          event.preventDefault()
          acceptSuggestion(suggestions[Math.min(selectedIndex, suggestions.length - 1)]!)
          return
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissed(true)
        return
      }
    }
    if (event.key === 'Escape' && dockIsOpen && historyVisible && historyOpen && !historyIdle(voice?.phase, historyRows.length, Boolean(voice))) {
      event.preventDefault()
      setHistoryOpen(false)
      return
    }
    if (event.key === 'Escape' && (onDismissPanel || onDismissComposer)) {
      event.preventDefault()
      if (onDismissPanel) onDismissPanel()
      else onDismissComposer?.()
      return
    }
    if (!context && event.ctrlKey && event.key.toLowerCase() === 'p') {
      event.preventDefault()
      void navigateHistory(-1)
      return
    }
    if (!context && event.ctrlKey && event.key.toLowerCase() === 'n') {
      event.preventDefault()
      void navigateHistory(1)
      return
    }
    if (!context && event.key === 'ArrowUp') {
      event.preventDefault()
      void navigateHistory(-1)
      return
    }
    if (!context && event.key === 'ArrowDown') {
      event.preventDefault()
      void navigateHistory(1)
      return
    }
    if (applyInputReadline(event)) return
    if (event.key === 'Enter') {
      event.preventDefault()
      void execute()
    }
  }

  const reviewPriority = composerDockReviewPriority(Boolean(children))
  const historyVisible = !contextualContent || reviewPriority
  /* The row above the dock body is the dock's own header, so it stands down
     whenever a contextual panel draws one of its own for the close to sit in. */
  const closeOwner = {
    dockOpen: dockIsOpen,
    panelHasHeader: contextualHasHeader,
    reviewPriority,
  }
  const closeInPanel = composerDockCloseInPanel(closeOwner)
  const historyChromeHosted = historyVisible && composerHistoryChromeHosted(closeOwner)
  const historyIsIdle = historyIdle(
    voice?.phase,
    historyRows.length,
    Boolean(voice),
  )
  const historyChrome: ComposerHistoryChromeValue = {
    idle: historyIsIdle,
    hosted: historyChromeHosted,
    open: historyOpen,
    captionId: historyCaptionId,
    onToggle: () => setHistoryOpen((current) => !current),
  }
  const dockControls: ComposerDockControls = {
    hide: hideDock,
    hideLabel: COMPOSER_DOCK_HIDE_LABEL,
  }
  const noticeInHeader = composerDockNoticeInHeader({ dockOpen: dockIsOpen, closeInPanel })
  const noticeLine = !hidden && outcomeSlot === 'composer' && notice ? (
    <ComposerStatusLine
      message={notice.message}
      tone={notice.tone}
      dismissLabel="Dismiss notice"
      onDismiss={onDismissNotice}
    />
  ) : null

  const composer = (
    <ComposerOutcomeContext.Provider value={outcomeSlotValue}>
    <ComposerDockContext.Provider value={dockControls}>
    <ComposerHistoryChromeContext.Provider value={historyChrome}>
    <section
      ref={composerRootRef}
      className="command-composer"
      data-composer-focus="return"
      data-dock-open={dockIsOpen ? 'true' : 'false'}
      hidden={hidden}
    >
      {dockIsOpen && !closeInPanel && (
        <div className="command-composer-dock-bar">
          {historyIsIdle && <span className="command-composer-dock-title">chat</span>}
          <ComposerHistoryControls />
          {noticeInHeader && noticeLine && (
            <span className="command-composer-dock-divider" aria-hidden="true" />
          )}
          {noticeInHeader && noticeLine}
          <ComposerDockClose />
        </div>
      )}
      <div
        className="command-composer-dock-body"
        hidden={!dockIsOpen}
        inert={!dockIsOpen ? true : undefined}
      >
      {contextualContent && (
        <div
          className="command-composer-contextual"
          hidden={reviewPriority}
          inert={reviewPriority ? true : undefined}
        >
          {contextualContent}
        </div>
      )}
      {!noticeInHeader && noticeLine}

      {!hidden && outcomeSlot === 'composer' && outcome && outcome.message !== notice?.message && (
        <ComposerStatusLine
          message={outcome.message}
          tone={outcome.ok ? 'info' : 'error'}
          dismissLabel="Dismiss error"
          onDismiss={outcome.ok ? undefined : () => setOutcome(null)}
        />
      )}

      {!hidden && !context && children}

      {!hidden && historyVisible && (
        <ComposerHistory
          rows={historyRows}
          phase={voice?.phase}
          voicePresent={Boolean(voice)}
          open={historyOpen && dockIsOpen}
          onToggle={() => setHistoryOpen((current) => !current)}
          onToggleCall={onToggleMcpCall}
        />
      )}

      {!hidden && voice && (historyVisible || voice.phase !== 'off' || voice.playbackBlocked) && (
        <VoiceComms
          voice={voice}
          sending={sending}
          mcpRunning={mcpCallsRunning(mcpCalls)}
        />
      )}
      </div>

      <form
        ref={commandRowRef}
        id={COMMAND_COMPOSER_FORM_ID}
        className={`command-line-shell ${transmitting ? 'command-line-shell-transmitting' : ''} ${mcpSucceeded ? 'command-line-shell-success' : ''} ${mcpFailed ? 'command-line-shell-error' : ''}`}
        aria-busy={transmitting}
        onKeyDown={event => {
          if (!actionDiscovery || event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
          event.preventDefault()
          event.stopPropagation()
          closeActionSearch()
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (actionDiscovery && actionMatches[activeActionIndex]) acceptAction(actionMatches[activeActionIndex]!)
          else {
            const submitter = (event.nativeEvent as SubmitEvent).submitter
            const reviewSubmit = submitter?.getAttribute('form') === COMMAND_COMPOSER_FORM_ID || (!submitter && document.activeElement?.closest('.confirm-sheet'))
            const reviewingVoice = (voice?.pendingReview || voiceReviewDraft) && pendingInput !== undefined && reviewSubmit
            void execute(reviewingVoice ? pendingInput : undefined)
          }
        }}
      >
        {actionDiscovery && <ComposerActionsPanel
          actions={actionMatches} groups={actionGroups} group={actionGroup} context={actionContext}
          loading={actionStatus.loading} error={actionStatus.error} listId={actionListId} selectedIndex={activeActionIndex}
          onGroupChange={group => { setActionGroup(group); setSelectedIndex(0); focusInput() }}
          onClose={closeActionSearch} onSelect={acceptAction} />}
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
            onTogglePreview={(voiceId, previewUrl) => { voice?.stop(); previewPlayer.toggle(voiceId, previewUrl) }}
            onRefresh={refreshVoiceCatalog}
          />
        )}
        {!speakPreviewOpen && suggestions.length > 0 && (
          <div className="command-suggestions" id={`${suggestionId}-list`} role="listbox" aria-label="Command suggestions">
            {suggestions.map((suggestion, index) => (
              <button
                type="button"
                role="option"
                id={`${suggestionId}-option-${index}`}
                aria-selected={index === selectedIndex}
                key={`${suggestion.type}:${suggestion.label}`}
                className={`${index === selectedIndex ? 'active ' : ''}${suggestion.type === 'cell' ? 'composer-reference-suggestion' : 'command-command-suggestion'}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => acceptSuggestion(suggestion)}
              >
                {suggestion.type === 'cell' ? <>
                  <ArtifactThumb asset={suggestion.reference.asset} kindHint={suggestion.reference.type} />
                  <span className="composer-reference-copy"><strong>{suggestion.label}</strong>
                    {suggestion.reference.label && <span>{suggestion.reference.label}</span>}
                    <small>{suggestion.description}</small></span>
                </> : <><strong>{suggestion.label}</strong><span>{suggestion.description}</span></>}
              </button>
            ))}
          </div>
        )}
        <div className="command-actions-controls">
          <button type="button" className="command-actions-toggle" aria-label="Open actions" aria-expanded={Boolean(actionDiscovery)}
            data-workspace-action-surface="button" aria-keyshortcuts="Control+Shift+K Meta+Shift+K"
            disabled={actionsDisabled || sending} onClick={actionDiscovery ? closeActionSearch : onOpenActions}>
            <ListFilter size={14} aria-hidden="true" />
          </button>

        </div>
        <RichComposerEditor
          ref={inputRef}
          value={actionDiscovery ? actionQuery : input}
          session={`${inputSession ?? 'chat'}:${actionDiscovery ? `actions-${actionDiscovery.key}` : 'draft'}`}
          sessions={editorSessions}
          references={references}
          disabled={actionDiscovery ? actionsDisabled : inputDisabled || sending}
          rich={!actionDiscovery}
          placeholder={actionDiscovery ? 'Search actions by name, operation or alias…' : disabled
            ? connectionLabel : placeholder ?? 'Type a message or /command…'}
          expanded={Boolean(actionDiscovery) || (!speakPreviewOpen && suggestions.length > 0)}
          controls={actionDiscovery ? actionListId : !speakPreviewOpen && suggestions.length > 0 ? `${suggestionId}-list` : undefined}
          activeDescendant={actionDiscovery && actionMatches[activeActionIndex] ? `${actionListId}-option-${activeActionIndex}`
            : !speakPreviewOpen && suggestions[selectedIndex] ? `${suggestionId}-option-${selectedIndex}` : undefined}
          onFocus={focusAndLoad}
          onCompositionChange={composing => { composingRef.current = composing }}
          onSelectionChange={setSelection}
          onChange={(value, nextSelection) => {
            setSelection(nextSelection)
            setSelectedIndex(0)
            if (actionDiscovery) { setActionQuery(value); return }
            setInput(value)
            setDismissed(false)
            historyCursorRef.current = -1
            ensureVoicesForInput(value)
          }}
          onKeyDown={handleInputKey}
        />
        {/* Mode and engine are one strip now: the lit cell names the mode you
            are in and carries that mode's engine, and the dim cell switches
            mode. ComposerModeSwitch owns the whole cluster, microphone
            included, so this row has one control per job. */}
        <ComposerModeSwitch
          chatModels={chatModels}
          selectedModel={selectedModel}
          modelSelectionDisabled={modelSelectionDisabled}
          sending={sending}
          context={context}
          voice={voice}
          onModelChange={onModelChange}
          onToggleVoice={toggleVoice}
        />
        <button
          type="submit"
          className="command-send"
          disabled={actionDiscovery ? actionsDisabled || actionMatches.length === 0 || actionStatus.loading : inputDisabled || sending || !input.trim()}
          aria-label={actionDiscovery ? 'Prepare action' : 'Send command'}
        >
          {sending ? <BusyIndicator size={14} /> : <Send size={14} />}
        </button>
        {transmitting && <span className="command-transmit-scan" aria-hidden="true" />}
      </form>
    </section>
    </ComposerHistoryChromeContext.Provider>
    </ComposerDockContext.Provider>
    </ComposerOutcomeContext.Provider>
  )

  return portalTarget ? createPortal(composer, portalTarget) : composer
}
