import { normalizeNotebookReference } from 'videobook-engine/notebook-mentions'

const CLIP_AUDIO_USAGE = 'Usage: /clip-audio @clip-id gain|mute|fade-in|fade-out <value>'

const CLIP_AUDIO_FIELDS = ['gain', 'mute', 'fade-in', 'fade-out'] as const

export type ClipAudioField = (typeof CLIP_AUDIO_FIELDS)[number]

export type ClipAudioSettings = {
  gainDb: number
  muted: boolean
  fadeInFrames: number
  fadeOutFrames: number
}

export type ClipAudioEdit =
  | { field: 'gain'; gainDb: number }
  | { field: 'mute'; muted: boolean }
  | { field: 'fade-in'; frames: number }
  | { field: 'fade-out'; frames: number }

export type ClipAudioEditRequest = {
  kind: 'volume'
  clip_id: string
  gain_db: number
  muted?: boolean
  fade_in_frames?: number
  fade_out_frames?: number
}

type ClipAudioSequence = {
  clips: readonly {
    clipId: string
    trackId: string
    audio?: ClipAudioSettings
  }[]
  tracks: readonly { trackId: string; kind: string }[]
}

export function parseClipAudioCommand(parts: readonly string[]):
  | { ok: true; clipRef: string; edit: ClipAudioEdit }
  | { ok: false; message: string } {
  const [clipRef, fieldValue, rawValue, extra] = parts
  const field = fieldValue?.toLowerCase()
  if (!clipRef || !field || rawValue === undefined || extra !== undefined || !isClipAudioField(field)) {
    return { ok: false, message: CLIP_AUDIO_USAGE }
  }
  const value = rawValue.trim()
  if (field === 'gain') {
    const gainDb = Number(value)
    if (!Number.isFinite(gainDb) || gainDb < -96 || gainDb > 24) {
      return { ok: false, message: 'Gain must be from -96 to 24 dB' }
    }
    return { ok: true, clipRef, edit: { field, gainDb } }
  }
  if (field === 'mute') {
    const muted = muteValue(value)
    if (muted === null) return { ok: false, message: 'Mute must be on or off' }
    return { ok: true, clipRef, edit: { field, muted } }
  }
  const frames = Number(value)
  if (!Number.isSafeInteger(frames) || frames < 0) {
    return { ok: false, message: 'Fade length must be a whole number of frames' }
  }
  return { ok: true, clipRef, edit: { field, frames } }
}

export function resolveClipAudioTarget(
  sequence: ClipAudioSequence | null,
  clipRef: string,
): { ok: true; clipId: string; audio: ClipAudioSettings } | { ok: false; message: string } {
  if (!sequence) return { ok: false, message: 'Load the primary sequence first.' }
  const token = normalizeNotebookReference(clipRef)
  const matches = sequence.clips.filter((clip) => clip.clipId.toLowerCase().startsWith(token))
  const clip = matches.length === 1 ? matches[0] : undefined
  if (!clip) return { ok: false, message: 'Choose one audio clip from the current sequence' }
  const track = sequence.tracks.find((candidate) => candidate.trackId === clip.trackId)
  if (track?.kind !== 'audio') {
    return { ok: false, message: '/clip-audio requires a clip on an audio track' }
  }
  return {
    ok: true,
    clipId: clip.clipId,
    audio: {
      gainDb: clip.audio?.gainDb ?? 0,
      muted: clip.audio?.muted ?? false,
      fadeInFrames: clip.audio?.fadeInFrames ?? 0,
      fadeOutFrames: clip.audio?.fadeOutFrames ?? 0,
    },
  }
}

export function clipAudioEditRequest(
  clipId: string,
  current: ClipAudioSettings,
  edit: ClipAudioEdit,
): ClipAudioEditRequest {
  return {
    kind: 'volume',
    clip_id: clipId,
    gain_db: edit.field === 'gain' ? edit.gainDb : current.gainDb,
    ...(edit.field === 'mute' ? { muted: edit.muted } : {}),
    ...(edit.field === 'fade-in' ? { fade_in_frames: edit.frames } : {}),
    ...(edit.field === 'fade-out' ? { fade_out_frames: edit.frames } : {}),
  }
}

function isClipAudioField(value: string): value is ClipAudioField {
  return (CLIP_AUDIO_FIELDS as readonly string[]).includes(value)
}

function muteValue(value: string): boolean | null {
  const token = value.toLowerCase()
  if (token === 'on' || token === 'true' || token === 'yes') return true
  if (token === 'off' || token === 'false' || token === 'no') return false
  return null
}
