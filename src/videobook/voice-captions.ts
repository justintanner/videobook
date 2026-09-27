import type { VoicePhase } from '../../server/src/voice-contract'

export function captionToggleLabel(visible: boolean): 'Hide log' | 'Show log' {
  return visible ? 'Hide log' : 'Show log'
}

export function captionsEmptyCopy(phase: VoicePhase): string {
  switch (phase) {
    case 'connecting':
      return 'Opening your voice channel…'
    case 'listening':
      return 'Listening… speak anytime.'
    case 'thinking':
      return 'Transcribing…'
    case 'speaking':
      return 'Waiting for captions…'
    case 'review':
      return 'Review is on screen.'
    case 'error':
      return 'No captions. Voice could not connect.'
    case 'off':
      return 'No captions this session.'
  }
}
