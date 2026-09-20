import { describe, expect, it } from 'vitest'
import {
  CONFIRM_SHEET_HINTS_MIN_WIDTH_PX,
  CONFIRM_SHEET_HINTS_QUERY,
  confirmSheetFooterVisible,
  confirmSheetHintsInHeader,
  type ConfirmSheetChromeInput,
} from './confirm-sheet-chrome'

function chrome(patch: Partial<ConfirmSheetChromeInput> = {}): ConfirmSheetChromeInput {
  return { state: 'ready', hasSecondaryActions: false, wideEnough: true, ...patch }
}

describe('where a confirm sheet keeps its shortcut hints', () => {
  it('puts them beside Apply while the sheet has nothing else to report', () => {
    expect(confirmSheetHintsInHeader(chrome())).toBe(true)
    expect(confirmSheetFooterVisible(chrome())).toBe(false)
  })

  it('gives the footer back the moment there is a message to carry', () => {
    for (const state of ['blocking', 'failed', 'busy', 'notice', 'info'] as const) {
      expect(confirmSheetHintsInHeader(chrome({ state }))).toBe(false)
      expect(confirmSheetFooterVisible(chrome({ state }))).toBe(true)
    }
  })

  it('keeps the footer for a sheet that offers another action', () => {
    expect(confirmSheetHintsInHeader(chrome({ hasSecondaryActions: true }))).toBe(false)
  })

  it('keeps the footer where the header has no room for the hints', () => {
    expect(confirmSheetHintsInHeader(chrome({ wideEnough: false }))).toBe(false)
    expect(confirmSheetFooterVisible(chrome({ wideEnough: false }))).toBe(true)
  })

  it('asks for the width the header needs', () => {
    expect(CONFIRM_SHEET_HINTS_MIN_WIDTH_PX).toBe(1024)
    expect(CONFIRM_SHEET_HINTS_QUERY).toBe('(min-width: 1024px)')
  })
})
