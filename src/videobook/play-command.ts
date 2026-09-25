type PlaySlotClip = {
  clipId: string
  trackId: string
  timelineStartFrame: number
}

type PlaySlotTrack = {
  trackId: string
  kind: string
  ordinal: number
}

type PlaySlotSequence = {
  clips: readonly PlaySlotClip[]
  tracks: readonly PlaySlotTrack[]
}

type PlaySlotResult =
  | { ok: true; initialFrame: number }
  | { ok: false; message: string }

export function resolvePlaySlot(
  slot: string | null,
  sequence: PlaySlotSequence | null,
): PlaySlotResult {
  if (!sequence) return { ok: false, message: 'Open a project with a sequence first.' }
  const slots = primaryVideoSlots(sequence)
  const token = slot?.trim() ?? ''
  if (!token) return { ok: true, initialFrame: slots[0]?.timelineStartFrame ?? 0 }
  const index = playSlotIndex(token)
  if (index === null) return { ok: false, message: 'Usage: /play [@s01]' }
  const clip = slots[index]
  if (!clip) return { ok: false, message: 'Choose an existing sequence slot.' }
  return { ok: true, initialFrame: clip.timelineStartFrame }
}

function primaryVideoSlots(sequence: PlaySlotSequence): PlaySlotClip[] {
  const videoTrack = sequence.tracks
    .filter((track) => track.kind === 'video')
    .sort((left, right) => left.ordinal - right.ordinal)[0]
  if (!videoTrack) return []
  return sequence.clips
    .filter((clip) => clip.trackId === videoTrack.trackId)
    .sort((left, right) =>
      left.timelineStartFrame - right.timelineStartFrame
      || left.clipId.localeCompare(right.clipId))
}

function playSlotIndex(value: string): number | null {
  const match = /^@?(?:s)?(\d+)$/iu.exec(value.trim())
  if (!match) return null
  const index = Number.parseInt(match[1] ?? '', 10) - 1
  return index >= 0 ? index : null
}
