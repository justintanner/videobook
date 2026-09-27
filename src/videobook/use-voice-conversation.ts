import { useLayoutEffect, useRef, useState } from 'react'
import { VoiceConnection } from './voice-connection'
import { nextHistorySequence } from './history-sequence'
import { COMPOSER_HISTORY_CAP } from './composer-history'
import type { VoiceCaption, VoiceMode, VoiceOutcome, VoicePhase, VoiceProvider, VoiceReviewCommand, VoiceSessionEvent } from '../../server/src/voice-contract'

const voiceModeKey = 'videobook.voice-provider'

function savedVoiceMode(): VoiceMode {
  try {
    const value = localStorage.getItem(voiceModeKey)
    return value === 'openai' || value === 'xai' ? value : 'auto'
  } catch { return 'auto' }
}

interface VoiceConversationOptions {
  onUserTurn?: () => void
  bookId: string
  notebookId?: string
  scope: string | null
  available: boolean
  disabled: boolean
  onAction: (event: Extract<VoiceSessionEvent, { type: 'action' }>, isCurrent: () => boolean) => Promise<VoiceOutcome>
  onReviewCommand: (command: VoiceReviewCommand) => Promise<VoiceOutcome>
}

export function useVoiceConversation(options: VoiceConversationOptions) {
  const [phase, setPhase] = useState<VoicePhase>('off')
  const [message, setMessage] = useState('Voice input + spoken replies')
  const [captions, setCaptions] = useState<VoiceCaption[]>([])
  const [playbackBlocked, setPlaybackBlocked] = useState(false)
  const [pendingReview, setPendingReview] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [mode, setMode] = useState<VoiceMode>(savedVoiceMode)
  const [provider, setProvider] = useState<VoiceProvider | null>(null)
  const [fallbackReason, setFallbackReason] = useState<string | undefined>()
  const meterRef = useRef<HTMLButtonElement>(null)
  const connectionRef = useRef<VoiceConnection | null>(null)
  const latest = useRef(options)

  useLayoutEffect(() => { latest.current = options })
  useLayoutEffect(() => () => {
    const connection = connectionRef.current
    connectionRef.current = null
    connection?.stop('Workspace changed. Start voice to resume.')
    setCaptions([])
    setProvider(null)
    setFallbackReason(undefined)
    setPendingReview(false)
    setRetrying(false)
  }, [options.bookId, options.notebookId, options.scope, options.available])

  const stop = () => {
    setPendingReview(false)
    setRetrying(false)
    connectionRef.current?.stop()
    setPhase('off')
    setMessage('Comms off.')
    setPlaybackBlocked(false)
    setProvider(null)
    setFallbackReason(undefined)
  }
  const toggle = () => {
    if (connectionRef.current?.active) { stop(); return }
    const current = latest.current
    if (!current.available || current.disabled) return
    setCaptions([])
    setProvider(null)
    setFallbackReason(undefined)
    setRetrying(false)
    setPhase('connecting')
    setMessage('Connecting voice')
    const userTurns = new Set<string>()
    const connection = new VoiceConnection({
      bookId: current.bookId, notebookId: current.notebookId,
      mode,
      onProvider: (next, reason) => {
        if (connectionRef.current !== connection) return
        setProvider(next)
        setFallbackReason(reason)
      },
      onPhase: (next, detail) => {
        if (connectionRef.current !== connection && next !== 'off') return
        setPhase(next)
        if (next === 'off' || next === 'error') setPendingReview(false)
        if (next !== 'thinking') setRetrying(false)
        if (detail) setMessage(detail)
      },
      onRetrying: (next) => {
        if (connectionRef.current !== connection) return
        setRetrying(next)
      },
      onCaption: caption => {
        if (connectionRef.current !== connection) return
        if (caption.role === 'user' && caption.final && caption.text.trim() && !userTurns.has(caption.id)) {
          userTurns.add(caption.id)
          latest.current.onUserTurn?.()
        }
        setCaptions(previous => {
          const existing = previous.findIndex(value => value.id === caption.id)
          if (existing < 0) {
            return [...previous, { ...caption, sequence: caption.sequence ?? nextHistorySequence() }]
              .slice(-COMPOSER_HISTORY_CAP)
          }
          const sequence = previous[existing]?.sequence ?? caption.sequence
          return previous.map(value => value.id === caption.id ? { ...caption, sequence } : value)
        })
      },
      onAction: async event => {
        if (connectionRef.current !== connection || latest.current.scope !== current.scope || latest.current.bookId !== current.bookId || latest.current.notebookId !== current.notebookId || !latest.current.available) {
          return { status: 'cancelled', message: 'Workspace changed. Repeat the command in the current workspace.' }
        }
        setPendingReview(true)
        const isCurrent = () => connectionRef.current === connection && connection.active && latest.current.bookId === current.bookId && latest.current.notebookId === current.notebookId && latest.current.scope === current.scope && latest.current.available
        const outcome = await latest.current.onAction(event, isCurrent).catch((error: unknown): VoiceOutcome => ({ status: 'failed', message: error instanceof Error ? error.message : 'Voice action failed.' }))
        if (connectionRef.current === connection) setPendingReview(outcome.status === 'review')
        return outcome
      },
      onReviewCommand: async command => {
        if (connectionRef.current !== connection) {
          return { status: 'cancelled', message: 'Workspace changed. The review is no longer on screen.' }
        }
        const outcome = await latest.current.onReviewCommand(command).catch((error: unknown): VoiceOutcome => ({ status: 'failed', message: error instanceof Error ? error.message : 'The review command failed.' }))
        if (connectionRef.current === connection) setPendingReview(outcome.status === 'review')
        return outcome
      },
      onLevel: level => meterRef.current?.style.setProperty('--voice-level', String(level)),
      onPlaybackBlocked: setPlaybackBlocked,
    })
    connectionRef.current = connection
    void connection.start()
  }

  return {
    phase, message, captions, playbackBlocked, pendingReview, retrying, meterRef, toggle, stop, mode, provider, fallbackReason,
    selectMode: (next: VoiceMode) => {
      if (next === mode) return
      setPendingReview(false)
      setRetrying(false)
      connectionRef.current?.stop('Voice provider changed. Start voice to connect.')
      setMode(next)
      setProvider(null)
      setFallbackReason(undefined)
      try { localStorage.setItem(voiceModeKey, next) } catch { return }
    },
    disabled: options.disabled || !options.available,
    active: phase !== 'off' && phase !== 'error',
    resumePlayback: () => { void connectionRef.current?.resumePlayback() },
    reportOutcome: (outcome: VoiceOutcome) => {
      if (outcome.status !== 'review') setPendingReview(false)
      connectionRef.current?.reportOutcome(outcome)
    },
    shareTypedTurn: (userText: string, assistantText: string) => connectionRef.current?.shareTypedTurn(userText, assistantText),
  }
}

export type VoiceConversation = ReturnType<typeof useVoiceConversation>
