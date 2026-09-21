export const MENU_GAP = 8
export const MENU_MAX_H = 320
export const MENU_MIN_H = 80
// The scrolling list sits inside a 1px border, so the box is that much taller
// than the height we cap the list at.
export const MENU_BORDER = 2
// Above every in-page layer, including the fullscreen media dialog's own
// chrome (440), so the menu always paints over whatever it is anchored to.
export const MENU_Z = 460

export interface AnchorRect {
  top: number
  bottom: number
  left: number
  width: number
}

export interface Viewport {
  width: number
  height: number
}

export interface MenuPosition {
  top: number
  left: number
  width: number
  maxHeight: number
  placeAbove: boolean
}

/**
 * Where the menu goes so that it lands over its anchor and stays on screen.
 *
 * Its own module, and its own tests: these sums are the whole of "is the menu
 * visible", and they are easier to pin down here than through a rendered page.
 */
export function measureMenuPosition(
  anchor: AnchorRect,
  viewport: Viewport,
  preferAbove: boolean,
  widthPx?: number,
): MenuPosition {
  // One gap between the field and the menu, one to keep the box off the window
  // edge. Counting only the first one is what used to leave the borders hanging
  // past the bottom of the screen.
  const spaceAbove = anchor.top - MENU_GAP * 2
  const spaceBelow = viewport.height - anchor.bottom - MENU_GAP * 2
  const placeAbove = preferAbove
    ? spaceAbove >= Math.min(MENU_MAX_H, spaceBelow) || spaceAbove > spaceBelow
    // Below unless it cannot seat the shortest useful menu: comparing the two
    // spaces directly sent the menu up into a sliver whenever the field sat
    // near the top of a tall window.
    : spaceBelow < MENU_MIN_H + MENU_BORDER && spaceAbove > spaceBelow
  const room = placeAbove ? spaceAbove : spaceBelow
  const maxHeight = Math.max(MENU_MIN_H, Math.min(MENU_MAX_H, room - MENU_BORDER))
  const boxHeight = maxHeight + MENU_BORDER
  const top = placeAbove
    ? Math.max(MENU_GAP, anchor.top - MENU_GAP - boxHeight)
    : Math.max(
      MENU_GAP,
      Math.min(anchor.bottom + MENU_GAP, viewport.height - MENU_GAP - boxHeight),
    )
  const width = widthPx ?? Math.max(anchor.width, 200)
  const left = Math.min(
    Math.max(MENU_GAP, anchor.left),
    viewport.width - width - MENU_GAP,
  )
  return { top, left, width, maxHeight, placeAbove }
}

/**
 * A modal <dialog> renders in the top layer, outside the normal stacking order,
 * so a menu portaled to document.body paints behind it however high its
 * z-index. It has to live inside the dialog to sit over its own anchor.
 */
export function menuPortalHost(anchor: Element | null): HTMLElement {
  return anchor?.closest('dialog[open]') ?? document.body
}
