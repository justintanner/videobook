// Where a confirm sheet's shortcut hints live, and whether the footer row is
// drawn at all. A ready sheet has nothing to report: its footer is 44px of
// shortcut text at the far end of the sheet from the two buttons those
// shortcuts drive. The header takes them, and the footer returns the moment
// there is a message to carry -- or another action that needs a home, or too
// little width to put the hints beside Apply.
import type { ConfirmSheetStatus } from './confirm-validation'

// Below this the header keeps the title, the address and the two buttons, and
// the hints go back to a row of their own.
export const CONFIRM_SHEET_HINTS_MIN_WIDTH_PX = 1024

export const CONFIRM_SHEET_HINTS_QUERY =
  `(min-width: ${CONFIRM_SHEET_HINTS_MIN_WIDTH_PX}px)`

export interface ConfirmSheetChromeInput {
  state: ConfirmSheetStatus['state']
  hasSecondaryActions: boolean
  wideEnough: boolean
}

export function confirmSheetHintsInHeader(input: ConfirmSheetChromeInput): boolean {
  return input.state === 'ready' && !input.hasSecondaryActions && input.wideEnough
}

export function confirmSheetFooterVisible(input: ConfirmSheetChromeInput): boolean {
  return !confirmSheetHintsInHeader(input)
}
