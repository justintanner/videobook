import { describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import {
  notebookAddressExpectationsAreStale,
  parseNotebookCoordinateAction,
  planNotebookCoordinateAction,
} from './notebook-coordinate-actions'

function cell(id: string, row: number, column: number): NotebookCell {
  return {
    id,
    type: 'prompt',
    slug: `prompt-${id}`,
    slot: { row, column },
  }
}

function document(cells: NotebookCell[]): NotebookDocument {
  return {
    id: 'notebook-1',
    name: 'Main',
    cells,
    edges: [],
    createdAt: new Date(0).toISOString(),
  }
}

describe('notebook coordinate chat actions', () => {
  it('parses addresses case-insensitively into zero-based grid slots', () => {
    expect(parseNotebookCoordinateAction('Move @A1 to @z13.')).toEqual({
      kind: 'move',
      source: { row: 0, column: 0 },
      destination: { row: 25, column: 12 },
    })
    expect(parseNotebookCoordinateAction('connect @B2 to @c3 as first_frame')).toEqual({
      kind: 'connect',
      source: { row: 1, column: 1 },
      target: { row: 2, column: 2 },
      targetInput: 'first_frame',
    })
    expect(parseNotebookCoordinateAction('execute cell @D4')).toEqual({
      kind: 'run',
      source: { row: 3, column: 3 },
    })
  })

  it('plans empty moves and occupied swaps with captured occupancy', () => {
    const current = document([cell('one', 0, 0), cell('two', 0, 1)])
    const move = planNotebookCoordinateAction(
      current,
      parseNotebookCoordinateAction('move @a1 to @b1')!,
    )
    expect(move.summary).toBe('Move @a1 to @b1')
    expect(move.expectations).toEqual([
      { address: '@a1', cellId: 'one' },
      { address: '@b1', cellId: null },
    ])

    const swap = planNotebookCoordinateAction(
      current,
      parseNotebookCoordinateAction('swap @a1 with @a2')!,
    )
    expect(swap.summary).toBe('Swap @a1 with @a2')
    expect(swap.expectations).toEqual([
      { address: '@a1', cellId: 'one' },
      { address: '@a2', cellId: 'two' },
    ])
  })

  it('auto-places new cells row-major and honors explicit destinations', () => {
    const current = document([cell('one', 0, 0), cell('three', 0, 2)])
    const automatic = planNotebookCoordinateAction(
      current,
      parseNotebookCoordinateAction('add a prompt cell')!,
    )
    expect(automatic.action).toEqual({
      kind: 'create',
      cellType: 'prompt',
      destination: { row: 0, column: 1 },
    })
    expect(automatic.summary).toBe('Create a prompt cell at @a2')

    const explicit = planNotebookCoordinateAction(
      current,
      parseNotebookCoordinateAction('create an image at @Z13')!,
    )
    expect(explicit.summary).toBe('Create a image cell at @z13')
    expect(explicit.expectations).toEqual([{ address: '@z13', cellId: null }])
  })

  it('rejects empty sources, occupied creates, and a full grid', () => {
    const current = document([cell('one', 0, 0)])
    expect(() => planNotebookCoordinateAction(
      current,
      parseNotebookCoordinateAction('delete @b1')!,
    )).toThrow('Notebook cell @b1 is empty')
    expect(() => planNotebookCoordinateAction(
      current,
      parseNotebookCoordinateAction('create a video at @a1')!,
    )).toThrow('Notebook cell @a1 is occupied')

    const full = document(Array.from({ length: 338 }, (_, index) =>
      cell(String(index), Math.floor(index / 13), index % 13)))
    expect(() => planNotebookCoordinateAction(
      full,
      parseNotebookCoordinateAction('create a prompt')!,
    )).toThrow('Notebook grid is full')
  })

  it('detects stale captured occupancy before apply', () => {
    const current = document([cell('one', 0, 0)])
    const plan = planNotebookCoordinateAction(
      current,
      parseNotebookCoordinateAction('move @a1 to @a2')!,
    )
    expect(notebookAddressExpectationsAreStale(current, plan.expectations)).toBe(false)
    expect(notebookAddressExpectationsAreStale(
      document([cell('one', 0, 0), cell('other', 0, 1)]),
      plan.expectations,
    )).toBe(true)
  })
})
