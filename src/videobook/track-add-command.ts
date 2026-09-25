const TRACK_ADD_USAGE = 'Usage: /track-add video|audio|caption [name]'

export function parseTrackAddCommand(
  parts: readonly string[],
): { ok: true; kind: 'video' | 'audio' | 'caption'; name: string } | { ok: false; message: string } {
  const [rawKind, ...nameParts] = parts
  const kind = rawKind?.toLowerCase()
  if (kind !== 'video' && kind !== 'audio' && kind !== 'caption') {
    return { ok: false, message: TRACK_ADD_USAGE }
  }
  return { ok: true, kind, name: nameParts.join(' ') }
}
