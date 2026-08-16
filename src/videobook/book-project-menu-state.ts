export type BookProjectMenuMode =
  | { kind: 'idle' }
  | { kind: 'create' }
  | { kind: 'rename'; bookId: string }
  | { kind: 'delete'; bookId: string }

export type BookProjectMenuModeAction =
  | { kind: 'begin-create' }
  | { kind: 'begin-rename'; bookId: string }
  | { kind: 'begin-delete'; bookId: string }
  | { kind: 'cancel' }
  | { kind: 'close' }
  | { kind: 'escape' }

type BookProjectMenuModeTransition = {
  closeMenu: boolean
  mode: BookProjectMenuMode
}

export function transitionBookProjectMenuMode(
  mode: BookProjectMenuMode,
  action: BookProjectMenuModeAction,
  pending: boolean,
): BookProjectMenuModeTransition {
  if (pending) return { mode, closeMenu: false }
  if (action.kind === 'close') {
    return { mode: { kind: 'idle' }, closeMenu: true }
  }
  if (action.kind === 'escape') {
    return mode.kind === 'idle'
      ? { mode, closeMenu: true }
      : { mode: { kind: 'idle' }, closeMenu: false }
  }
  if (action.kind === 'cancel') {
    return mode.kind === 'idle'
      ? { mode, closeMenu: false }
      : { mode: { kind: 'idle' }, closeMenu: false }
  }
  if (action.kind === 'begin-create') {
    return { mode: { kind: 'create' }, closeMenu: false }
  }
  if (action.kind === 'begin-rename') {
    return {
      mode: { kind: 'rename', bookId: action.bookId },
      closeMenu: false,
    }
  }
  return {
    mode: { kind: 'delete', bookId: action.bookId },
    closeMenu: false,
  }
}
