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
  if (phase === 'error') {
    return { kind: 'error', label: 'Connection error', busy: false }
  }
  if (phase === 'review') {
    return { kind: 'review', label: 'Review on screen', busy: false }
  }
  if (input.retrying) {
    return { kind: 'retrying', label: 'Retrying reply', busy: true }
  }
  if (input.sending) {
    return { kind: 'sending', label: 'Sending', busy: true }
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
