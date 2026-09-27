import type { VoicePhase } from '../../server/src/voice-contract'

export type ComposerActivityKind =
  | 'idle'
  | 'permission'
  | 'connecting'
  | 'listening'
  | 'waiting'
  | 'preparing'
  | 'review'
  | 'speaking'
  | 'retrying'
  | 'paused'
  | 'error'
  | 'sending'

export interface ComposerActivityStatus {
  kind: ComposerActivityKind
  label: string
  busy: boolean
}

export interface ComposerActivityInput {
  sending: boolean
  mcpRunning: number
  voicePhase?: VoicePhase
  voiceMessage?: string
  retrying?: boolean
  pendingReview?: boolean
}

const PAUSED_MESSAGE = /page is hidden|paused for media playback|You are offline/i

function preparingFromReview(phase: VoicePhase | undefined, pendingReview: boolean | undefined): boolean {
  if (!pendingReview) return false
  return phase === 'connecting' || phase === 'thinking' || phase === 'listening' || phase === 'speaking'
}

export function composerActivityStatus(input: ComposerActivityInput): ComposerActivityStatus {
  const phase = input.voicePhase
  if (input.sending) {
    return { kind: 'sending', label: 'Sending', busy: true }
  }
  if (phase === 'error') {
    return { kind: 'error', label: 'Connection error', busy: false }
  }
  if (phase === 'review') {
    return { kind: 'review', label: 'Review on screen', busy: false }
  }
  if (input.retrying) {
    return { kind: 'retrying', label: 'Retrying reply', busy: true }
  }
  if (input.mcpRunning > 0 || preparingFromReview(phase, input.pendingReview)) {
    return { kind: 'preparing', label: 'Preparing an action', busy: true }
  }
  if (phase === 'connecting') {
    if (/allow microphone/i.test(input.voiceMessage ?? '')) {
      return { kind: 'permission', label: 'Allow microphone access', busy: true }
    }
    return { kind: 'connecting', label: 'Connecting voice', busy: true }
  }
  if (phase === 'thinking') {
    return { kind: 'waiting', label: 'Waiting for reply', busy: true }
  }
  if (phase === 'speaking') {
    return { kind: 'speaking', label: 'Speaking', busy: false }
  }
  if (phase === 'listening') {
    return { kind: 'listening', label: 'Listening', busy: false }
  }
  if (phase === 'off' && PAUSED_MESSAGE.test(input.voiceMessage ?? '')) {
    return { kind: 'paused', label: 'Voice paused. Start voice to resume.', busy: false }
  }
  return { kind: 'idle', label: phase === 'off' ? 'Offline' : '', busy: false }
}

// States the rest of the screen already shows: a review sheet is visibly on
// screen, and a live or idle microphone is lit in the mode switch beside the
// message box. Naming them again in the transcript is a line of chrome that
// says nothing, so the status line is drawn only for the states that are news
// -- a permission prompt, a connection, a reply being waited on, a failure.
const SILENT_ACTIVITY = new Set<ComposerActivityKind>(['idle', 'listening', 'review'])

export function composerActivityWorthShowing(status: ComposerActivityStatus): boolean {
  return !SILENT_ACTIVITY.has(status.kind) && status.label !== ''
}

export interface VoiceActivityFeedback {
  message: string | null
  busy: boolean
  error: boolean
  fallbackReason: string | null
  playbackBlocked: boolean
}

export function voiceActivityFeedback(voice: {
  phase: VoicePhase
  message: string
  retrying: boolean
  pendingReview: boolean
  fallbackReason?: string
  playbackBlocked: boolean
} | undefined): VoiceActivityFeedback | null {
  if (!voice) return null
  const status = composerActivityStatus({
    sending: false,
    mcpRunning: 0,
    voicePhase: voice.phase,
    voiceMessage: voice.message,
    retrying: voice.phase !== 'off' && voice.retrying,
    pendingReview: voice.pendingReview,
  })
  const showStatus = composerActivityWorthShowing(status)
    && status.kind !== 'connecting'
    && status.kind !== 'permission'
  const message = showStatus
    ? status.kind === 'error' ? voice.message || status.label : status.label
    : null
  const fallbackReason = voice.phase === 'off' || voice.phase === 'error'
    ? null
    : voice.fallbackReason ?? null
  if (!message && !fallbackReason && !voice.playbackBlocked) return null
  return {
    message,
    busy: showStatus && status.busy,
    error: status.kind === 'error',
    fallbackReason,
    playbackBlocked: voice.playbackBlocked,
  }
}
