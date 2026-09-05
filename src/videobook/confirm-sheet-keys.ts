// Keyboard model shared by every confirm sheet. Pure: the DOM event is
// reduced to this shape by the sheet component, so the rules are testable
// without a browser.

type ConfirmSheetKeyAction = 'apply' | 'cancel' | 'none'

export interface ConfirmSheetKeyTarget {
  tagName: string
  type?: string | null
}

export interface ConfirmSheetKeyEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  defaultPrevented: boolean
  target: ConfirmSheetKeyTarget | null
}

interface ConfirmSheetKeyOptions {
  busy: boolean
}

// Enter in one of these applies, like the default button of a dialog.
// Buttons, checkboxes, ranges, selects and textareas keep their own Enter.
const SINGLE_LINE_INPUT_TYPES = new Set([
  '',
  'text',
  'number',
  'url',
  'search',
  'email',
  'tel',
  'date',
  'time',
  'datetime-local',
  'password',
])

export function isSingleLineTextTarget(target: ConfirmSheetKeyTarget | null): boolean {
  if (!target || target.tagName.toLowerCase() !== 'input') return false
  return SINGLE_LINE_INPUT_TYPES.has((target.type ?? '').toLowerCase())
}

export function confirmSheetKeyAction(
  event: ConfirmSheetKeyEvent,
  options: ConfirmSheetKeyOptions,
): ConfirmSheetKeyAction {
  // A body that consumed the key (the split editor commits bounds on Enter)
  // marks the event; the sheet never double-handles it.
  if (event.defaultPrevented) return 'none'
  if (event.key === 'Escape') return options.busy ? 'none' : 'cancel'
  if (event.key !== 'Enter' || event.altKey) return 'none'
  if (options.busy) return 'none'
  if (event.metaKey || event.ctrlKey) return 'apply'
  return isSingleLineTextTarget(event.target) ? 'apply' : 'none'
}
