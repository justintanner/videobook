import { describe, expect, it } from 'vitest'
import {
  MENU_BORDER,
  MENU_GAP,
  MENU_MAX_H,
  MENU_MIN_H,
  measureMenuPosition,
} from './autocomplete-position'

const VIEWPORT = { width: 1920, height: 906 }

function boxBottom(pos: { top: number; maxHeight: number }): number {
  return pos.top + pos.maxHeight + MENU_BORDER
}

describe('measureMenuPosition', () => {
  it('keeps the whole box on screen when the field sits near the bottom', () => {
    // The prompt field of a selected cell: 109px of room under it, which the
    // menu used to fill with its list alone and then overflow by its borders.
    const anchor = { top: 573, bottom: 789, left: 53, width: 1805 }

    const pos = measureMenuPosition(anchor, VIEWPORT, false)

    expect(pos.placeAbove).toBe(false)
    expect(pos.top).toBe(anchor.bottom + MENU_GAP)
    expect(boxBottom(pos)).toBeLessThanOrEqual(VIEWPORT.height)
  })

  it('never lets the box run off either edge, wherever the field is', () => {
    for (let bottom = 40; bottom < VIEWPORT.height; bottom += 17) {
      const anchor = { top: Math.max(0, bottom - 200), bottom, left: 53, width: 600 }
      for (const preferAbove of [true, false]) {
        const pos = measureMenuPosition(anchor, VIEWPORT, preferAbove)
        expect(pos.top).toBeGreaterThanOrEqual(MENU_GAP)
        expect(pos.maxHeight).toBeGreaterThanOrEqual(MENU_MIN_H)
        // A field pinned within a menu's minimum height of both edges cannot be
        // served; everywhere else the box fits.
        const roomAnywhere = Math.max(
          anchor.top - MENU_GAP * 2,
          VIEWPORT.height - anchor.bottom - MENU_GAP * 2,
        )
        if (roomAnywhere >= MENU_MIN_H + MENU_BORDER) {
          expect(boxBottom(pos)).toBeLessThanOrEqual(VIEWPORT.height)
        }
      }
    }
  })

  it('opens upward for a field at the bottom of the window', () => {
    const pos = measureMenuPosition(
      { top: 820, bottom: 880, left: 53, width: 600 },
      VIEWPORT,
      true,
    )

    expect(pos.placeAbove).toBe(true)
    expect(boxBottom(pos)).toBeLessThanOrEqual(820 - MENU_GAP + MENU_BORDER)
  })

  it('opens downward for a field at the top of the window', () => {
    const pos = measureMenuPosition(
      { top: 20, bottom: 80, left: 53, width: 600 },
      VIEWPORT,
      true,
    )

    expect(pos.placeAbove).toBe(false)
    expect(pos.top).toBe(80 + MENU_GAP)
  })

  it('caps the list rather than growing with the room available', () => {
    const pos = measureMenuPosition(
      { top: 40, bottom: 80, left: 53, width: 600 },
      { width: 1920, height: 4000 },
      false,
    )

    expect(pos.maxHeight).toBe(MENU_MAX_H)
  })

  it('matches the anchor width, with a floor, and stays inside the window', () => {
    expect(measureMenuPosition({ top: 100, bottom: 140, left: 53, width: 1805 }, VIEWPORT, false).width)
      .toBe(1805)
    expect(measureMenuPosition({ top: 100, bottom: 140, left: 53, width: 60 }, VIEWPORT, false).width)
      .toBe(200)

    const nearRight = measureMenuPosition(
      { top: 100, bottom: 140, left: 1850, width: 400 },
      VIEWPORT,
      false,
      400,
    )
    expect(nearRight.left + nearRight.width).toBeLessThanOrEqual(VIEWPORT.width)
    expect(nearRight.left).toBeGreaterThanOrEqual(MENU_GAP)
  })

  it('honours an explicit width over the anchor', () => {
    expect(measureMenuPosition({ top: 100, bottom: 140, left: 53, width: 1805 }, VIEWPORT, false, 420).width)
      .toBe(420)
  })
})
