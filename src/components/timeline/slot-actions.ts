export function getClearSlotCommand(
  label: string,
  hasContent: boolean,
  hasMenu: boolean,
): string | null {
  if (!hasContent || !hasMenu) return null
  return `/unassign ${label}`
}

export function getRemoveSlotCommand(
  label: string,
  isStored: boolean,
  hasMenu: boolean,
): string | null {
  if (!isStored || !hasMenu) return null
  return `/remove-slot ${label}`
}
