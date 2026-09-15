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

  it('shows the last two back and forths and nothing above them', () => {
    const rows = [
      caption({ id: 'u1', text: 'make a sea dance video' }),
      caption({ id: 'a1', role: 'assistant', text: 'Ready to apply.' }),
      caption({ id: 'u2', text: 'apply' }),
      caption({ id: 'a2', role: 'assistant', text: 'Queued as cell D4.' }),
      caption({ id: 'u3', text: 'delete the failed generation at @e3' }),
      caption({ id: 'a3', role: 'assistant', text: 'Ready to apply.' }),
      caption({ id: 'u4', text: 'apply' }),
      caption({ id: 'a4', role: 'assistant', text: 'That artifact is still referenced.' }),
    ]
    expect(displayableCaptions(rows).map(row => row.id)).toEqual(['u3', 'a3', 'u4', 'a4'])
    // A reply still streaming in is the second half of the newest exchange.
    expect(displayableCaptions(rows.slice(0, 7)).map(row => row.id))
      .toEqual(['u3', 'a3', 'u4'])
  })

  it('keeps a short conversation whole, including anything said before the first turn', () => {
    const greeting = caption({ id: 'a0', role: 'assistant', text: 'Voice ready.' })
    expect(displayableCaptions([greeting]).map(row => row.id)).toEqual(['a0'])
    expect(displayableCaptions([
      greeting,
      caption({ id: 'u1', text: 'hello' }),
      caption({ id: 'a1', role: 'assistant', text: 'hi' }),
    ]).map(row => row.id)).toEqual(['a0', 'u1', 'a1'])
  })

  it('counts an exchange from the speaker, not from every row', () => {
    // Two spoken turns in a row, with no reply between them, are two exchanges.
    expect(displayableCaptions([
      caption({ id: 'u1', text: 'one' }),
      caption({ id: 'u2', text: 'two' }),
      caption({ id: 'u3', text: 'three' }),
    ]).map(row => row.id)).toEqual(['u2', 'u3'])
    // A blank row is dropped before the window is measured, so it never
    // silently counts as one of the two.
    expect(displayableCaptions([
      caption({ id: 'u1', text: 'one' }),
      caption({ id: 'blank', text: '   ', final: false }),
      caption({ id: 'a1', role: 'assistant', text: 'reply' }),
    ]).map(row => row.id)).toEqual(['u1', 'a1'])
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
