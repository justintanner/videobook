import { describe, expect, it } from 'vitest'
import type { VoicePhase } from '../../server/src/voice-contract'
import {
  captionToggleLabel,
  captionsEmptyCopy,
} from '../../src/videobook/voice-captions'

describe('voice caption visibility helpers', () => {
  it('names the control Hide log or Show log from visibility', () => {
    expect(captionToggleLabel(true)).toBe('Hide log')
    expect(captionToggleLabel(false)).toBe('Show log')
  })

  it('covers empty-state copy for idle, live, waiting, review and error', () => {
    const phases: VoicePhase[] = ['off', 'connecting', 'listening', 'thinking', 'speaking', 'review', 'error']
    for (const phase of phases) {
      expect(captionsEmptyCopy(phase).length).toBeGreaterThan(0)
    }
    expect(captionsEmptyCopy('connecting')).toMatch(/Opening/)
    expect(captionsEmptyCopy('listening')).toMatch(/Listening/)
    expect(captionsEmptyCopy('thinking')).toMatch(/Transcribing/)
    expect(captionsEmptyCopy('speaking')).toMatch(/Waiting/)
    expect(captionsEmptyCopy('review')).toMatch(/Review/)
    expect(captionsEmptyCopy('error')).toMatch(/could not connect/)
    expect(captionsEmptyCopy('off')).toMatch(/this session/)
  })
})
