import { describe, expect, it } from 'vitest'
import {
  clipAudioEditRequest,
  parseClipAudioCommand,
  resolveClipAudioTarget,
} from './clip-audio-command'

const USAGE = 'Usage: /clip-audio @clip-id gain|mute|fade-in|fade-out <value>'

const audioClipId = '01900000-0000-7000-8000-0000000000aa'
const videoClipId = '01900000-0000-7000-8000-0000000000bb'
const sequence = {
  tracks: [
    { trackId: 'audio-track', kind: 'audio' },
    { trackId: 'video-track', kind: 'video' },
  ],
  clips: [
    {
      clipId: audioClipId,
      trackId: 'audio-track',
      audio: { gainDb: -3, muted: false, fadeInFrames: 4, fadeOutFrames: 8 },
    },
    { clipId: videoClipId, trackId: 'video-track' },
  ],
}

describe('/clip-audio', () => {
  it('parses gain, mute, and fade edits', () => {
    expect(parseClipAudioCommand([`@${audioClipId}`, 'gain', '-6'])).toEqual({
      ok: true,
      clipRef: `@${audioClipId}`,
      edit: { field: 'gain', gainDb: -6 },
    })
    expect(parseClipAudioCommand([audioClipId, 'MUTE', 'off'])).toEqual({
      ok: true,
      clipRef: audioClipId,
      edit: { field: 'mute', muted: false },
    })
    expect(parseClipAudioCommand([audioClipId, 'fade-in', '12'])).toEqual({
      ok: true,
      clipRef: audioClipId,
      edit: { field: 'fade-in', frames: 12 },
    })
  })

  it('rejects incomplete or out-of-range edits', () => {
    expect(parseClipAudioCommand([])).toEqual({ ok: false, message: USAGE })
    expect(parseClipAudioCommand([audioClipId, 'pan', '2'])).toEqual({ ok: false, message: USAGE })
    expect(parseClipAudioCommand([audioClipId, 'gain', '30'])).toEqual({
      ok: false,
      message: 'Gain must be from -96 to 24 dB',
    })
    expect(parseClipAudioCommand([audioClipId, 'mute', 'sometimes'])).toEqual({
      ok: false,
      message: 'Mute must be on or off',
    })
    expect(parseClipAudioCommand([audioClipId, 'fade-out', '1.5'])).toEqual({
      ok: false,
      message: 'Fade length must be a whole number of frames',
    })
  })

  it('resolves one audio-track clip and keeps the other audio settings', () => {
    const parsed = parseClipAudioCommand([`@${audioClipId.slice(0, 35)}`, 'fade-out', '18'])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const target = resolveClipAudioTarget(sequence, parsed.clipRef)
    expect(target).toEqual({
      ok: true,
      clipId: audioClipId,
      audio: sequence.clips[0]!.audio,
    })
    if (!target.ok) return
    expect(clipAudioEditRequest(target.clipId, target.audio, parsed.edit)).toEqual({
      kind: 'volume',
      clip_id: audioClipId,
      gain_db: -3,
      fade_out_frames: 18,
    })
  })

  it('rejects a missing sequence, an ambiguous prefix, and a video clip', () => {
    expect(resolveClipAudioTarget(null, audioClipId).ok).toBe(false)
    expect(resolveClipAudioTarget(sequence, '01900000').ok).toBe(false)
    expect(resolveClipAudioTarget(sequence, videoClipId)).toEqual({
      ok: false,
      message: '/clip-audio requires a clip on an audio track',
    })
  })
})
