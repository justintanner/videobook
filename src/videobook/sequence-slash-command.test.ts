import { describe, expect, it } from 'vitest'
import { APPLICATION_COMMANDS } from '../../server/src/tools/application-commands'
import {
  parseSequenceSlashCommand,
  type SequenceSlashContext,
} from './sequence-slash-command'

const videoClipId = '01900000-0000-7000-8000-0000000000aa'
const audioClipId = '01900000-0000-7000-8000-0000000000bb'
const stillClipId = '01900000-0000-7000-8000-0000000000cc'
const assetId = '01900000-0000-7000-8000-0000000000dd'

const context: SequenceSlashContext = {
  sequence: {
    tracks: [
      { trackId: 'video-track', kind: 'video', name: 'Picture' },
      { trackId: 'audio-track', kind: 'audio', name: 'Music' },
    ],
    clips: [
      {
        clipId: videoClipId,
        trackId: 'video-track',
        source: { kind: 'timed', artifactId: assetId },
        speed: { numerator: 1, denominator: 1 },
        reverse: false,
        audioPolicy: 'preserve-pitch',
      },
      {
        clipId: audioClipId,
        trackId: 'audio-track',
        source: { kind: 'timed', artifactId: assetId },
        speed: { numerator: 1, denominator: 1 },
        reverse: false,
        audioPolicy: 'preserve-pitch',
        audio: { gainDb: -3, muted: false, fadeInFrames: 4, fadeOutFrames: 8 },
      },
      {
        clipId: stillClipId,
        trackId: 'video-track',
        source: { kind: 'still', artifactId: assetId },
      },
    ],
  },
  assets: [{ id: 'media-1', artifactId: assetId }],
  mentionAssets: [{ cellAddress: 'a1', artifactId: assetId }],
}

describe('sequence slash commands', () => {
  it('deletes a sequence clip with /delete and leaves other targets to asset delete', () => {
    expect(parseSequenceSlashCommand('/delete', [`@${videoClipId}`, 'extra'], context)).toEqual({
      handled: true,
      ok: false,
      message: 'Usage: /delete @clip-id [--ripple]',
    })
    expect(parseSequenceSlashCommand('/delete', ['missing'], context)).toEqual({ handled: false })
    expect(parseSequenceSlashCommand('/delete', [`@${videoClipId}`, '--ripple'], context)).toEqual({
      handled: true,
      ok: true,
      request: { kind: 'delete', clip_id: videoClipId, ripple: true },
    })
  })

  it('trims a sequence clip in frames and leaves media trim to /trim', () => {
    expect(parseSequenceSlashCommand('/trim', [`@${videoClipId}`, '0'], context)).toEqual({
      handled: true,
      ok: false,
      message: 'Usage: /trim @clip-id <start-frame> <duration-frames>',
    })
    expect(parseSequenceSlashCommand('/trim', ['@a1', '0', '2'], context)).toEqual({ handled: false })
    expect(parseSequenceSlashCommand('/trim', [videoClipId, '0', '15'], context)).toEqual({
      handled: true,
      ok: true,
      request: {
        kind: 'trim',
        clip_id: videoClipId,
        timeline_start_frame: 0,
        duration_frames: 15,
      },
    })
  })

  it('reverses only a timed sequence clip', () => {
    expect(parseSequenceSlashCommand('/reverse', [stillClipId], context)).toEqual({
      handled: true,
      ok: false,
      message: '/reverse requires a timed clip',
    })
    expect(parseSequenceSlashCommand('/reverse', [], context)).toEqual({ handled: false })
    expect(parseSequenceSlashCommand('/reverse', [videoClipId], context)).toMatchObject({
      handled: true,
      ok: true,
      request: { kind: 'speed', clip_id: videoClipId, reverse: true, audio_policy: 'preserve-pitch' },
    })
  })

  it('refuses visual edits and volume changes on the wrong track kind', () => {
    expect(parseSequenceSlashCommand('/fit', [audioClipId, 'fit'], context)).toEqual({
      handled: true,
      ok: false,
      message: '/fit requires a visual clip',
    })
    expect(parseSequenceSlashCommand('/crop', [audioClipId], context)).toEqual({
      handled: true,
      ok: false,
      message: 'Automatic reframe requires a visual clip',
    })
    expect(parseSequenceSlashCommand('/clip-audio', [videoClipId, '-6'], context)).toEqual({
      handled: true,
      ok: false,
      message: '/clip-audio requires a clip on an audio track',
    })
    expect(parseSequenceSlashCommand('/fit', [videoClipId, 'Fill'], context)).toEqual({
      handled: true,
      ok: true,
      request: { kind: 'transform', clip_id: videoClipId, fit: 'fill' },
    })
    expect(parseSequenceSlashCommand('/clip-audio', [audioClipId, '-6'], context)).toMatchObject({
      handled: true,
      ok: true,
      request: { kind: 'volume', clip_id: audioClipId, gain_db: -6 },
    })
    expect(parseSequenceSlashCommand('/duck', [videoClipId], context)).toEqual({
      handled: true,
      ok: false,
      message: 'Ducking requires a narration clip on an audio track',
    })
    expect(parseSequenceSlashCommand('/duck', [audioClipId, '-8'], context)).toEqual({
      handled: true,
      ok: true,
      request: { kind: 'duck', narration_clip_id: audioClipId, reduction_db: -8 },
    })
  })

  it('inserts a gap instead of describing a removal', () => {
    expect(APPLICATION_COMMANDS.find((command) => command.command === '/gap')?.description)
      .toBe('Preview inserting a gap that shifts later clips forward')
    expect(parseSequenceSlashCommand('/gap', ['0', '30', 'Music'], context)).toEqual({
      handled: true,
      ok: true,
      request: {
        kind: 'gap',
        timeline_start_frame: 0,
        duration_frames: 30,
        track_ids: ['audio-track'],
      },
    })
  })

  it('accepts a caption style regardless of case', () => {
    expect(parseSequenceSlashCommand('/caption', ['0', '90', 'Bold', 'Opening scene'], context)).toEqual({
      handled: true,
      ok: true,
      request: {
        kind: 'caption',
        timeline_start_frame: 0,
        duration_frames: 90,
        text: 'Opening scene',
        style_id: 'bold',
      },
    })
  })
})
