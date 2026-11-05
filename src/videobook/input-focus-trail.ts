export type InputFocusTrail = {
  readonly cellIds: readonly string[]
  readonly tipCellId: string
}

function isCurrent(trail: InputFocusTrail | null, cellId: string): trail is InputFocusTrail {
  return trail !== null && trail.tipCellId === cellId
}

export function pushInputFocus(
  trail: InputFocusTrail | null,
  fromCellId: string,
  inputCellId: string,
): InputFocusTrail {
  const earlier = isCurrent(trail, fromCellId) ? trail.cellIds : []
  return { cellIds: [...earlier, fromCellId], tipCellId: inputCellId }
}

export function inputFocusBackTarget(
  trail: InputFocusTrail | null,
  selectedCellId: string,
): string | null {
  if (!isCurrent(trail, selectedCellId)) return null
  return trail.cellIds.at(-1) ?? null
}

export function popInputFocus(trail: InputFocusTrail): InputFocusTrail | null {
  const target = trail.cellIds.at(-1)
  if (target === undefined || trail.cellIds.length < 2) return null
  return { cellIds: trail.cellIds.slice(0, -1), tipCellId: target }
}
