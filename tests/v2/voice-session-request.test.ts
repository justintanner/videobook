import { describe, expect, it } from 'vitest'
import {
  createVoiceSessionRequest,
  voiceNeedsWebRtcOffer,
} from '../../src/videobook/voice-connection'

describe('voice session request', () => {
  it('skips the WebRTC offer for an explicit xAI session', () => {
    expect(voiceNeedsWebRtcOffer('xai')).toBe(false)
    expect(voiceNeedsWebRtcOffer('openai')).toBe(true)
    expect(voiceNeedsWebRtcOffer('auto')).toBe(true)
    const xai = createVoiceSessionRequest({
      bookId: 'reel',
      notebookId: 'nb-1',
      mode: 'xai',
      sampleRate: 48_000,
      sdp: 'v=0\r\ns=should-not-send\r\n',
    })
    expect(xai.url).toBe('/api/voice')
    expect(xai.body).toEqual({
      bookId: 'reel',
      notebookId: 'nb-1',
      mode: 'xai',
      sampleRate: 48_000,
    })
    expect(xai.body).not.toHaveProperty('sdp')
    const openai = createVoiceSessionRequest({
      bookId: 'reel',
      mode: 'openai',
      sampleRate: 48_000,
      sdp: 'v=0\r\ns=voice-session\r\n',
    })
    expect(openai.body.sdp).toBe('v=0\r\ns=voice-session\r\n')
  })
})
