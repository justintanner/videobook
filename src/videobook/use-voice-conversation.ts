import { useLayoutEffect, useRef, useState } from 'react'
import { VoiceConnection } from './voice-connection'
import type { VoiceCaption, VoiceMode, VoiceOutcome, VoicePhase, VoiceProvider, VoiceSessionEvent } from '../../server/src/voice-contract'

const voiceModeKey = 'videobook.voice-provider'

function savedVoiceMode(): VoiceMode {
  try {
    const value = localStorage.getItem(voiceModeKey)
    return value === 'openai' || value === 'xai' ? value : 'auto'
  } catch { return 'auto' }
}

interface VoiceConversationOptions {
  bookId: string
  notebookId?: string
  scope: string | null
  available: boolean
  disabled: boolean
  onAction: (event: Extract<VoiceSessionEvent, { type: 'action' }>, isCurrent: () => boolean) => Promise<VoiceOutcome>
}

export function useVoiceConversation(options: VoiceConversationOptions) {
  const [phase, setPhase] = useState<VoicePhase>('off')
  const [message, setMessage] = useState('Voice input + spoken replies')
  const [captions, setCaptions] = useState<VoiceCaption[]>([])
  const [playbackBlocked, setPlaybackBlocked] = useState(false)
  const [pendingReview, setPendingReview] = useState(false)
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
  }, [options.bookId, options.notebookId, options.scope, options.available])

  const stop = () => connectionRef.current?.stop()
  const toggle = () => {
    if (connectionRef.current?.active) { stop(); return }
    const current = latest.current
    if (!current.available || current.disabled) return
    setCaptions([])
    setProvider(null)
    setFallbackReason(undefined)
    setMessage('Speak naturally. Interrupt anytime.')
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
        if (detail) setMessage(detail)
      },
      onCaption: caption => {
        if (connectionRef.current !== connection) return
        setCaptions(previous => {
          const existing = previous.findIndex(value => value.id === caption.id)
          if (existing < 0) return [...previous, caption].slice(-24)
          return previous.map(value => value.id === caption.id ? caption : value)
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
      onLevel: level => meterRef.current?.style.setProperty('--voice-level', String(level)),
      onPlaybackBlocked: setPlaybackBlocked,
    })
    connectionRef.current = connection
    void connection.start()
  }

  return {
    phase, message, captions, playbackBlocked, pendingReview, meterRef, toggle, stop, mode, provider, fallbackReason,
    selectMode: (next: VoiceMode) => {
      if (next === mode) return
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
