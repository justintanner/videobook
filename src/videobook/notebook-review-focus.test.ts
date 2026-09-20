import { describe, expect, it, vi } from 'vitest'
import { notebookGrid } from './notebook-grid'
import {
  NO_NOTEBOOK_REVIEW,
  notebookRowScrollTop,
  notebookReviewRoles,
  notebookReviewUnchanged,
  revealNotebookReviewRow,
} from './notebook-review-focus'

describe('roles an open review puts on the canvas', () => {
  it('marks what the apply writes to apart from what it reads', () => {
    const roles = notebookReviewRoles({ target: 'b4', sources: ['a4', 'a5'] })
    expect(roles.get('b4')).toBe('target')
    expect(roles.get('a4')).toBe('source')
    expect(roles.get('a5')).toBe('source')
    expect(roles.size).toBe(3)
  })

  it('reads an address that is both as the target, because that is what changes', () => {
    expect(notebookReviewRoles({ target: 'a4', sources: ['a4'] }).get('a4')).toBe('target')
  })

  it('marks nothing when no review is open', () => {
    expect(notebookReviewRoles(NO_NOTEBOOK_REVIEW).size).toBe(0)
  })

  it('treats the same addresses in the same order as the same review', () => {
    expect(notebookReviewUnchanged(
      { target: 'b4', sources: ['a4'] },
      { target: 'b4', sources: ['a4'] },
    )).toBe(true)
    expect(notebookReviewUnchanged(
      { target: 'b4', sources: ['a4'] },
      { target: 'b4', sources: ['a5'] },
    )).toBe(false)
    expect(notebookReviewUnchanged(
      { target: 'b4', sources: [] },
      { target: 'b5', sources: [] },
    )).toBe(false)
  })
})

describe('scrolling the reviewed row into the middle of the canvas', () => {
  const rowCenter = (row: number) =>
    notebookGrid.originY + row * notebookGrid.rowPitch + notebookGrid.squareSize / 2

  it('puts the row centre on the middle of what you can see', () => {
    const top = notebookRowScrollTop({
      row: 6,
      zoom: 1,
      clientHeight: 600,
      scrollHeight: 8000,
    })
    expect(top).toBe(Math.round(rowCenter(6) - 300))
  })

  it('scales the row position by the canvas zoom', () => {
    const top = notebookRowScrollTop({
      row: 6,
      zoom: 0.5,
      clientHeight: 600,
      scrollHeight: 8000,
    })
    expect(top).toBe(Math.round(rowCenter(6) * 0.5 - 300))
  })

  it('never scrolls above the top or past the end', () => {
    expect(notebookRowScrollTop({
      row: 0,
      zoom: 1,
      clientHeight: 900,
      scrollHeight: 4000,
    })).toBe(0)
    expect(notebookRowScrollTop({
      row: 40,
      zoom: 1,
      clientHeight: 600,
      scrollHeight: 1400,
    })).toBe(800)
  })

  it('falls back to the top for a row that is not a row', () => {
    expect(notebookRowScrollTop({
      row: Number.NaN,
      zoom: 1,
      clientHeight: 600,
      scrollHeight: 8000,
    })).toBe(0)
  })
})

describe('revealing the reviewed row', () => {
  function target(scrollTop: number) {
    return {
      clientHeight: 600,
      scrollHeight: 8000,
      scrollTop,
      scrollTo: vi.fn(),
    }
  }

  const runFrame = (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  }

  it('scrolls smoothly to the row the review names', () => {
    const element = target(0)
    revealNotebookReviewRow(() => element, { row: 6, zoom: 1 }, { scheduleFrame: runFrame })
    expect(element.scrollTo).toHaveBeenCalledWith({
      top: notebookRowScrollTop({ row: 6, zoom: 1, clientHeight: 600, scrollHeight: 8000 }),
      behavior: 'smooth',
    })
  })

  it('jumps instead of gliding when motion is turned down', () => {
    const element = target(0)
    revealNotebookReviewRow(
      () => element,
      { row: 6, zoom: 1 },
      { reducedMotion: true, scheduleFrame: runFrame },
    )
    expect(element.scrollTo.mock.calls[0]?.[0].behavior).toBe('auto')
  })

  it('leaves the canvas alone when the row is already centred', () => {
    const settled = notebookRowScrollTop({
      row: 6,
      zoom: 1,
      clientHeight: 600,
      scrollHeight: 8000,
    })
    const element = target(settled)
    revealNotebookReviewRow(() => element, { row: 6, zoom: 1 }, { scheduleFrame: runFrame })
    expect(element.scrollTo).not.toHaveBeenCalled()
  })

  it('does nothing when the canvas is not on screen', () => {
    expect(() => revealNotebookReviewRow(
      () => null,
      { row: 6, zoom: 1 },
      { scheduleFrame: runFrame },
    )).not.toThrow()
  })
})
