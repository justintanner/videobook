// A generated result flashes an accent ring for a few seconds so the eye can
// find the cell the run just finished, without selecting it (selection opens
// the inspector) and without riding the 900ms arrival animation.
export const HIGHLIGHT_MS = 2400

export function addHighlight(
  current: ReadonlySet<string>,
  cellIds: readonly string[],
): ReadonlySet<string> {
  const added = cellIds.filter((cellId) => !current.has(cellId))
  if (added.length === 0) return current
  return new Set([...current, ...added])
}

export function expireHighlight(
  current: ReadonlySet<string>,
  cellIds: readonly string[],
): ReadonlySet<string> {
  const remaining = [...current].filter((cellId) => !cellIds.includes(cellId))
  if (remaining.length === current.size) return current
  return new Set(remaining)
}
