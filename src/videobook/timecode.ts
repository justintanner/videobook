/** Formats a frame as `m:ss.xx` at the given frame rate. */
export function formatTimecode(frame: number, fps: number): string {
  const seconds = Math.max(0, frame / fps)
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds - minutes * 60
  return `${minutes}:${remainder.toFixed(2).padStart(5, '0')}`
}

/**
 * Parses `m:ss.xx`, `ss.xx` or `F<frame>` into a whole frame, or null when the
 * text is not a time. Seconds may exceed 59 when no minutes are given.
 */
export function parseTimecode(text: string, fps: number): number | null {
  const trimmed = text.trim()
  const frameMatch = /^f(\d+)$/i.exec(trimmed)
  if (frameMatch) return Number(frameMatch[1])
  const match = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(trimmed)
  if (!match) return null
  const minutes = match[1] ? Number(match[1]) : 0
  const seconds = Number(match[2])
  if (match[1] && seconds >= 60) return null
  return Math.round((minutes * 60 + seconds) * fps)
}
