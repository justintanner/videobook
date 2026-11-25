import { describe, expect, it } from 'vitest'
import {
  notebookRevealScroll,
  type NotebookRevealGeometry,
  type NotebookRevealRect,
} from '../../src/videobook/notebook-result-reveal'

const canvasTop = 60
const canvasLeft = 28

function geometry(input: {
  cell: { top: number; left: number; width?: number; height?: number }
  scrollTop: number
  scrollLeft?: number
  dockTop: number
  width?: number
  height?: number
  contentHeight?: number
  contentWidth?: number
}): NotebookRevealGeometry {
  const width = input.width ?? 1400
  const height = input.height ?? 900
  const scrollLeft = input.scrollLeft ?? 0
  const cellTop = canvasTop + input.cell.top - input.scrollTop
  const cellLeft = canvasLeft + input.cell.left - scrollLeft
  const cells: NotebookRevealRect = {
    top: cellTop,
    bottom: cellTop + (input.cell.height ?? 136),
    left: cellLeft,
    right: cellLeft + (input.cell.width ?? 164),
  }
  return {
    visible: {
      top: canvasTop,
      bottom: Math.min(canvasTop + height, input.dockTop),
      left: canvasLeft,
      right: canvasLeft + width,
    },
    cells,
    scrollTop: input.scrollTop,
    scrollLeft,
    maxScrollTop: (input.contentHeight ?? 2000) - height,
    maxScrollLeft: (input.contentWidth ?? width) - width,
  }
}

describe('notebook cell reveal scroll', () => {
  it('turns a smooth scroll still heading for a spot the dock has since moved', () => {
    const settled = geometry({ cell: { top: 860, left: 500 }, scrollTop: 640, dockTop: 560 })
    const target = notebookRevealScroll(settled, 'center')!
    const nearTarget = geometry({ cell: { top: 860, left: 500 }, scrollTop: target.top - 1, dockTop: 560 })

    expect(notebookRevealScroll(nearTarget, 'center')).toBeNull()
    expect(notebookRevealScroll(nearTarget, 'center', true, { top: target.top + 3, left: target.left })).toEqual(target)
  })

  it('leaves a smooth scroll alone once it is heading for the right spot', () => {
    const settled = geometry({ cell: { top: 860, left: 500 }, scrollTop: 640, dockTop: 560 })
    const target = notebookRevealScroll(settled, 'center')!
    const nearTarget = geometry({ cell: { top: 860, left: 500 }, scrollTop: target.top - 1, dockTop: 560 })

    expect(notebookRevealScroll(nearTarget, 'center', true, { top: target.top + 1, left: target.left })).toBeNull()
  })

  it('brings row a back when a new tile lands there after the canvas scrolled down', () => {
    const next = notebookRevealScroll(geometry({
      cell: { top: 20, left: 8 },
      scrollTop: 640,
      dockTop: 560,
    }), 'center')

    expect(next).toEqual({ top: 0, left: 0 })
  })

  it('centers a new tile in the space above an open preview dock', () => {
    const next = notebookRevealScroll(geometry({
      cell: { top: 860, left: 500 },
      scrollTop: 0,
      dockTop: 560,
    }), 'center')

    const visibleHeight = 560 - canvasTop
    expect(next).toEqual({ top: 860 - (visibleHeight - 136) / 2, left: 0 })
  })

  it('treats a tile behind the preview dock as offscreen and leaves visible tiles alone', () => {
    const hidden = geometry({ cell: { top: 520, left: 500 }, scrollTop: 0, dockTop: 560 })
    const visible = geometry({ cell: { top: 120, left: 500 }, scrollTop: 0, dockTop: 560 })

    expect(notebookRevealScroll(hidden, 'offscreen')).not.toBeNull()
    expect(notebookRevealScroll(visible, 'offscreen')).toBeNull()
  })

  it('aligns the top of a batch taller than the visible area', () => {
    const next = notebookRevealScroll(geometry({
      cell: { top: 900, left: 8, height: 700 },
      scrollTop: 0,
      dockTop: 560,
    }), 'center')

    expect(next).toEqual({ top: 900 - 16, left: 0 })
  })

  it('scrolls sideways on a phone only when the new tile is outside the viewport', () => {
    const phone = { width: 390, height: 700, contentWidth: 1044, dockTop: 600 }
    const offscreen = notebookRevealScroll(geometry({
      ...phone,
      cell: { top: 20, left: 760, width: 120, height: 100 },
      scrollTop: 0,
    }), 'center')
    const onscreen = notebookRevealScroll(geometry({
      ...phone,
      cell: { top: 300, left: 100, width: 120, height: 100 },
      scrollTop: 0,
    }), 'center')

    expect(offscreen).toEqual({ top: 0, left: 760 + 120 - 390 + 16 })
    expect(onscreen?.left).toBe(0)
  })

  it('keeps the horizontal position for a clicked tile reveal', () => {
    const next = notebookRevealScroll(geometry({
      width: 390,
      height: 700,
      contentWidth: 1044,
      dockTop: 600,
      cell: { top: 900, left: 760, width: 120, height: 100 },
      scrollTop: 0,
      scrollLeft: 100,
    }), 'center', false)

    expect(next?.left).toBe(100)
  })

  it('does not scroll when the tile is already centered', () => {
    const visibleHeight = 560 - canvasTop
    const scrollTop = 860 - (visibleHeight - 136) / 2

    expect(notebookRevealScroll(geometry({
      cell: { top: 860, left: 500 },
      scrollTop,
      dockTop: 560,
    }), 'center')).toBeNull()
  })

  it('does nothing while the dock covers the whole canvas', () => {
    expect(notebookRevealScroll(geometry({
      cell: { top: 20, left: 8 },
      scrollTop: 400,
      dockTop: canvasTop,
    }), 'center')).toBeNull()
  })
})
