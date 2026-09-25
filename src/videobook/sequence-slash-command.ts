import { normalizeNotebookReference } from 'videobook-engine/notebook-mentions'
import {
  clipAudioEditRequest,
  parseClipAudioCommand,
  resolveClipAudioTarget,
} from './clip-audio-command'

type SequenceSlashClip = {
  clipId: string
  trackId: string
  source: { kind: string; artifactId: string }
  speed?: { numerator: number; denominator: number }
  reverse?: boolean
  audioPolicy?: 'preserve-pitch' | 'resample' | 'mute'
  audio?: {
    gainDb: number
    muted: boolean
    fadeInFrames: number
    fadeOutFrames: number
  }
}

type SequenceSlashTrack = {
  trackId: string
  kind: string
  name: string
}

export type SequenceSlashContext = {
  sequence: {
    clips: readonly SequenceSlashClip[]
    tracks: readonly SequenceSlashTrack[]
  } | null
  assets: readonly { id: string; artifactId: string }[]
  mentionAssets: readonly { cellAddress: string; artifactId: string }[]
}

export type SequenceSlashResult =
  | { handled: false }
  | { handled: true; ok: false; message: string }
  | { handled: true; ok: true; request: Record<string, unknown> }

const SEQUENCE_COMMANDS = new Set([
  '/caption',
  '/move',
  '/split-clip',
  '/clip-delete',
  '/gap',
  '/fit',
  '/reframe',
  '/clip-reverse',
  '/clip-audio',
  '/duck',
  '/insert',
  '/overwrite',
  '/clip-trim',
  '/volume',
])

export function parseSequenceSlashCommand(
  commandToken: string,
  restParts: readonly string[],
  context: SequenceSlashContext,
): SequenceSlashResult {
  if (commandToken === '/delete' || commandToken === '/trim' || commandToken === '/reverse') {
    if (!clipReference(context.sequence, restParts[0])) return { handled: false }
  } else if (!SEQUENCE_COMMANDS.has(commandToken)) {
    return { handled: false }
  }
  const failure = (message: string): SequenceSlashResult => ({ handled: true, ok: false, message })
  const success = (request: Record<string, unknown>): SequenceSlashResult => ({ handled: true, ok: true, request })
  const sequence = context.sequence

  if (commandToken === '/caption') {
    const [startValue, durationValue, styleValue, ...textParts] = restParts
    const startFrame = Number(startValue)
    const durationFrames = Number(durationValue)
    const style = styleValue?.toLowerCase()
    const captionStyle = style === 'clean' || style === 'bold' || style === 'high-contrast' ? style : null
    const text = textParts.join(' ').trim()
    if (
      !Number.isSafeInteger(startFrame)
      || startFrame < 0
      || !Number.isSafeInteger(durationFrames)
      || durationFrames < 1
      || !captionStyle
      || !text
    ) {
      return failure('Usage: /caption <start-frame> <duration-frames> clean|bold|high-contrast <text>')
    }
    return success({
      kind: 'caption',
      timeline_start_frame: startFrame,
      duration_frames: durationFrames,
      text,
      style_id: captionStyle,
    })
  }

  if (commandToken === '/move') {
    const [clipValue, trackValue, startValue] = restParts
    const clip = clipReference(sequence, clipValue)
    const track = trackReference(sequence, trackValue)
    const startFrame = Number(startValue)
    if (!clip || !track || !Number.isSafeInteger(startFrame) || startFrame < 0) {
      return failure('Usage: /move @clip-id @track-id <start-frame>')
    }
    return success({
      kind: 'move',
      clip_id: clip.clipId,
      track_id: track.trackId,
      timeline_start_frame: startFrame,
    })
  }

  if (commandToken === '/split-clip') {
    const [clipValue, frameValue] = restParts
    const clip = clipReference(sequence, clipValue)
    const splitFrame = Number(frameValue)
    if (!clip || !Number.isSafeInteger(splitFrame) || splitFrame < 0) {
      return failure('Usage: /split-clip @clip-id <sequence-frame>')
    }
    return success({
      kind: 'split',
      clip_id: clip.clipId,
      split_frame: splitFrame,
    })
  }

  if (commandToken === '/clip-delete' || commandToken === '/delete') {
    const clip = clipReference(sequence, restParts[0])
    const unknown = restParts.slice(1).filter((value) => value !== '--ripple')
    if (!clip || unknown.length > 0) {
      return failure('Usage: /clip-delete @clip-id [--ripple]')
    }
    return success({
      kind: 'delete',
      clip_id: clip.clipId,
      ripple: restParts.includes('--ripple'),
    })
  }

  if (commandToken === '/gap') {
    const startFrame = Number(restParts[0])
    const durationFrames = Number(restParts[1])
    const track = trackReference(sequence, restParts[2])
    if (
      !Number.isSafeInteger(startFrame)
      || startFrame < 0
      || !Number.isSafeInteger(durationFrames)
      || durationFrames < 1
      || (restParts[2] !== undefined && !track)
    ) {
      return failure('Usage: /gap <start-frame> <duration-frames> [@track-id]')
    }
    return success({
      kind: 'gap',
      timeline_start_frame: startFrame,
      duration_frames: durationFrames,
      ...(track ? { track_ids: [track.trackId] } : {}),
    })
  }

  if (commandToken === '/fit') {
    const clip = clipReference(sequence, restParts[0])
    const fit = restParts[1]?.toLowerCase()
    if (!clip || (fit !== 'fit' && fit !== 'fill' && fit !== 'crop')) {
      return failure('Usage: /fit @clip-id fit|fill|crop')
    }
    if (trackOf(sequence, clip)?.kind !== 'video') {
      return failure('/fit requires a visual clip')
    }
    return success({
      kind: 'transform',
      clip_id: clip.clipId,
      fit,
    })
  }

  if (commandToken === '/reframe') {
    const clip = clipReference(sequence, restParts[0])
    if (!clip) return failure('Usage: /reframe @visual-clip-id')
    if (trackOf(sequence, clip)?.kind !== 'video') {
      return failure('Automatic reframe requires a visual clip')
    }
    return success({
      kind: 'reframe',
      clip_id: clip.clipId,
    })
  }

  if (commandToken === '/clip-reverse' || commandToken === '/reverse') {
    const clip = clipReference(sequence, restParts[0])
    if (!clip) return failure('Usage: /clip-reverse @timed-clip-id')
    if (clip.source.kind !== 'timed' || !clip.speed || clip.reverse === undefined || !clip.audioPolicy) {
      return failure('/clip-reverse requires a timed clip')
    }
    return success({
      kind: 'speed',
      clip_id: clip.clipId,
      numerator: clip.speed.numerator,
      denominator: clip.speed.denominator,
      reverse: !clip.reverse,
      audio_policy: clip.audioPolicy,
    })
  }

  if (commandToken === '/clip-audio') {
    const parsed = parseClipAudioCommand(restParts)
    if (!parsed.ok) return failure(parsed.message)
    const target = resolveClipAudioTarget(sequence, parsed.clipRef)
    if (!target.ok) return failure(target.message)
    return success(clipAudioEditRequest(target.clipId, target.audio, parsed.edit))
  }

  if (commandToken === '/duck') {
    const clip = clipReference(sequence, restParts[0])
    const reductionDb = restParts[1] === undefined ? -12 : Number(restParts[1])
    if (!clip || !Number.isFinite(reductionDb) || reductionDb < -36 || reductionDb > -1) {
      return failure('Usage: /duck @narration-clip-id [reduction-db from -36 to -1]')
    }
    if (trackOf(sequence, clip)?.kind !== 'audio') {
      return failure('Ducking requires a narration clip on an audio track')
    }
    return success({
      kind: 'duck',
      narration_clip_id: clip.clipId,
      reduction_db: reductionDb,
    })
  }

  if (commandToken === '/insert' || commandToken === '/overwrite' || commandToken === '/clip-trim' || commandToken === '/trim' || commandToken === '/volume') {
    const values = restParts.map((value) => value.startsWith('@') ? value.slice(1) : value)
    if (commandToken === '/insert' || commandToken === '/overwrite') {
      const [source, startValue, durationValue] = values
      const mentionAsset = context.mentionAssets.find((candidate) =>
        candidate.cellAddress.toLowerCase() === source?.toLowerCase())
      const asset = mentionAsset ?? context.assets.find((candidate) =>
        candidate.id === source || candidate.artifactId === source)
      const startFrame = Number(startValue)
      const durationFrames = durationValue === undefined ? undefined : Number(durationValue)
      if (
        !asset
        || !Number.isSafeInteger(startFrame)
        || startFrame < 0
        || (durationFrames !== undefined && (!Number.isSafeInteger(durationFrames) || durationFrames < 1))
      ) {
        return failure(`Usage: ${commandToken} @asset <start-frame> [duration-frames]`)
      }
      return success({
        kind: 'insert',
        mode: commandToken === '/overwrite' ? 'overwrite' : 'insert',
        artifact_id: asset.artifactId,
        timeline_start_frame: startFrame,
        ...(durationFrames === undefined ? {} : { duration_frames: durationFrames }),
      })
    }
    if (commandToken === '/clip-trim' || commandToken === '/trim') {
      const [clipValue, startValue, durationValue] = values
      const clip = clipReference(sequence, clipValue)
      const startFrame = Number(startValue)
      const durationFrames = Number(durationValue)
      if (
        !clip
        || !Number.isSafeInteger(startFrame)
        || startFrame < 0
        || !Number.isSafeInteger(durationFrames)
        || durationFrames < 1
      ) {
        return failure('Usage: /clip-trim @clip-id <start-frame> <duration-frames>')
      }
      return success({
        kind: 'trim',
        clip_id: clip.clipId,
        timeline_start_frame: startFrame,
        duration_frames: durationFrames,
      })
    }
    const [clipValue, gainValue] = values
    const clip = clipReference(sequence, clipValue)
    const gainDb = Number(gainValue)
    if (!clip || !Number.isFinite(gainDb) || gainDb < -96 || gainDb > 24) {
      return failure('Usage: /volume @clip-id <gain-db from -96 to 24>')
    }
    if (trackOf(sequence, clip)?.kind !== 'audio') {
      return failure('Volume changes require a clip on an audio track')
    }
    return success({
      kind: 'volume',
      clip_id: clip.clipId,
      gain_db: gainDb,
    })
  }

  return { handled: false }
}

function clipReference(sequence: SequenceSlashContext['sequence'], value: string | undefined) {
  if (!sequence || !value) return undefined
  const token = normalizeNotebookReference(value)
  const matches = sequence.clips.filter((clip) => clip.clipId.toLowerCase().startsWith(token))
  return matches.length === 1 ? matches[0] : undefined
}

function trackReference(sequence: SequenceSlashContext['sequence'], value: string | undefined) {
  if (!sequence || !value) return undefined
  const token = normalizeNotebookReference(value)
  const matches = sequence.tracks.filter((track) =>
    track.trackId.toLowerCase().startsWith(token) || track.name.toLowerCase() === token)
  return matches.length === 1 ? matches[0] : undefined
}

function trackOf(sequence: SequenceSlashContext['sequence'], clip: SequenceSlashClip) {
  return sequence?.tracks.find((track) => track.trackId === clip.trackId)
}
