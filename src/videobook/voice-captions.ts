import type { VoiceCaption, VoicePhase } from '../../server/src/voice-contract'

export function captionToggleLabel(visible: boolean): 'Hide captions' | 'Show captions' {
  return visible ? 'Hide captions' : 'Show captions'
}

const VISIBLE_EXCHANGES = 2

/**
 * The last two back and forths, and nothing above them. An exchange starts
 * when the speaker talks, so the window opens at the second-to-last user row
 * and runs to the end, keeping whatever the copilot said in reply. The whole
 * conversation stays in state for the model and the history log; this is only
 * what the panel shows, so it cannot grow taller than the work behind it.
 */
export function displayableCaptions(captions: readonly VoiceCaption[]): VoiceCaption[] {
  const rows = captions.filter((caption) =>
    caption.text.trim().length > 0 || Boolean(caption.interrupted))
  const spoken = rows.flatMap((caption, index) =>
    caption.role === 'user' ? [index] : [])
  const from = spoken.at(-VISIBLE_EXCHANGES)
  return from === undefined ? rows : rows.slice(from)
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
