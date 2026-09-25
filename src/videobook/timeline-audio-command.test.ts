import { describe, expect, it } from 'vitest'
import { resolveTimelineAudioTarget } from './timeline-audio-command'

const clipId = '01900000-0000-7000-8000-0000000000aa'
const otherClipId = '01900000-0000-7000-8000-0000000000bb'
const artifactId = '01900000-0000-7000-8000-0000000000cc'
const sequence = {
  tracks: [
    { trackId: 'audio-track', kind: 'audio' },
    { trackId: 'video-track', kind: 'video' },
  ],
  clips: [
    { clipId, trackId: 'audio-track', source: { artifactId } },
    { clipId: otherClipId, trackId: 'video-track', source: { artifactId } },
  ],
}

describe('timeline audio slash targets', () => {
  it('resolves a grid address to the audio clip, not the video clip', () => {
    expect(resolveTimelineAudioTarget('@a1', sequence, [{ id: 'media', artifactId }], [
      { cellAddress: 'a1', artifactId },
    ])).toEqual({ ok: true, clipId })
  })

  it('resolves a clip id and rejects an address that is not on the timeline', () => {
    expect(resolveTimelineAudioTarget(clipId, sequence, [], [])).toEqual({ ok: true, clipId })
    expect(resolveTimelineAudioTarget('@b2', sequence, [], [
      { cellAddress: 'b2', artifactId: '01900000-0000-7000-8000-0000000000dd' },
    ])).toEqual({ ok: false, message: 'That audio asset is not on the timeline' })
    expect(resolveTimelineAudioTarget('a1', null, [], [])).toEqual({
      ok: false,
      message: 'Load the primary sequence first.',
    })
  })
})
