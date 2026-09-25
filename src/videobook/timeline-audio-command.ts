import {
  isNotebookGridAddress,
  normalizeNotebookReference,
} from 'videobook-engine/notebook-mentions'

type TimelineAudioClip = {
  clipId: string
  trackId: string
  source: { artifactId: string }
}

type TimelineAudioSequence = {
  clips: readonly TimelineAudioClip[]
  tracks: readonly { trackId: string; kind: string }[]
}

const MISSING = 'Choose a timeline audio clip or the audio asset on the timeline'

export function resolveTimelineAudioTarget(
  reference: string,
  sequence: TimelineAudioSequence | null,
  assets: readonly { id: string; artifactId: string }[],
  mentions: readonly { cellAddress: string; artifactId: string }[],
): { ok: true; clipId: string } | { ok: false; message: string } {
  if (!sequence) return { ok: false, message: 'Load the primary sequence first.' }
  const token = normalizeNotebookReference(reference)
  if (!token) return { ok: false, message: MISSING }
  const audioTrackIds = new Set(sequence.tracks.filter((track) => track.kind === 'audio').map((track) => track.trackId))
  const audioClips = sequence.clips.filter((clip) => audioTrackIds.has(clip.trackId))
  if (!isNotebookGridAddress(token)) {
    const byClipId = audioClips.filter((clip) => clip.clipId.toLowerCase().startsWith(token))
    if (byClipId.length === 1) return { ok: true, clipId: byClipId[0]!.clipId }
    if (byClipId.length > 1) return { ok: false, message: 'Choose one timeline audio clip' }
  }
  const mention = mentions.find((entry) => entry.cellAddress.toLowerCase() === token)
  const asset = assets.find((entry) => entry.id.toLowerCase() === token || entry.artifactId.toLowerCase() === token)
  const artifactId = mention?.artifactId ?? asset?.artifactId
  if (!artifactId) return { ok: false, message: MISSING }
  const matches = audioClips.filter((clip) => clip.source.artifactId === artifactId)
  if (matches.length === 1) return { ok: true, clipId: matches[0]!.clipId }
  if (matches.length === 0) return { ok: false, message: 'That audio asset is not on the timeline' }
  return { ok: false, message: 'Choose one timeline audio clip' }
}
