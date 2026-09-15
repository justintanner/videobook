import { describe, expect, it } from 'vitest'
import type { VoiceCaption, VoicePhase } from '../../server/src/voice-contract'
import {
  captionToggleLabel,
  captionsEmptyCopy,
  displayableCaptions,
} from '../../src/videobook/voice-captions'

const caption = (overrides: Partial<VoiceCaption> & Pick<VoiceCaption, 'id'>): VoiceCaption => ({
  role: 'user',
  text: 'hello',
  final: true,
  ...overrides,
})

describe('voice caption visibility helpers', () => {
  it('names the control Show captions or Hide captions from visibility', () => {
    expect(captionToggleLabel(true)).toBe('Hide captions')
    expect(captionToggleLabel(false)).toBe('Show captions')
  })

  it('keeps interrupted or non-empty rows and drops blank YOU/COPILOT rows', () => {
    expect(displayableCaptions([
      caption({ id: 'empty', text: '   ', final: false }),
      caption({ id: 'partial', text: 'hi', final: false }),
      caption({ id: 'cut', text: '', interrupted: true, final: true }),
    ])).toEqual([
      caption({ id: 'partial', text: 'hi', final: false }),
      caption({ id: 'cut', text: '', interrupted: true, final: true }),
    ])
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
