import { describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import { planImageGrouping } from './notebook-group-images'

function cell(
  id: string,
  row: number,
  column: number,
  type: NotebookCell['type'] = 'prompt',
): NotebookCell {
  return { id, type, slot: { row, column } }
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

describe('planImageGrouping', () => {
  it('packs images rightward from the anchor in reading order', () => {
    const current = document([
      cell('i1', 3, 9, 'image'),
      cell('i2', 0, 1, 'image'),
      cell('other', 5, 5),
    ])
    const result = planImageGrouping(
      current,
      new Set(['i1', 'i2']),
      { row: 7, column: 2 },
    )
    expect(result).toEqual({
      ok: true,
      slots: [
        { id: 'i2', row: 7, column: 2 },
        { id: 'i1', row: 7, column: 3 },
      ],
      movedCount: 2,
      displacedCount: 0,
    })
  })

  it('wraps onto the next row once a line fills the last column', () => {
    const images = Array.from({ length: 14 }, (_, index) =>
      cell(`i${index}`, 10 + index, 0, 'image'))
    const result = planImageGrouping(
      document(images),
      new Set(images.map((image) => image.id)),
      { row: 1, column: 0 },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.slots).toEqual([
      ...Array.from({ length: 13 }, (_, column) => ({
        id: `i${column}`,
        row: 1,
        column,
      })),
      { id: 'i13', row: 2, column: 0 },
    ])
    expect(result.movedCount).toBe(14)
    expect(result.displacedCount).toBe(0)
  })

  it('wraps back to the grid origin when the run passes the last slot', () => {
    const current = document([
      cell('i1', 5, 5, 'image'),
      cell('i2', 6, 6, 'image'),
      cell('i3', 7, 7, 'image'),
    ])
    const result = planImageGrouping(
      current,
      new Set(['i1', 'i2', 'i3']),
      { row: 25, column: 11 },
    )
    expect(result.ok && result.slots).toEqual([
      { id: 'i1', row: 25, column: 11 },
      { id: 'i2', row: 25, column: 12 },
      { id: 'i3', row: 0, column: 0 },
    ])
  })

  it('pushes non-image cells on target slots out to free slots in reading order', () => {
    const current = document([
      cell('i1', 9, 9, 'image'),
      cell('i2', 10, 10, 'image'),
      cell('i3', 11, 11, 'image'),
      cell('blocker-a', 1, 4),
      cell('blocker-b', 1, 5),
      cell('bystander', 6, 6),
    ])
    const result = planImageGrouping(
      current,
      new Set(['i1', 'i2', 'i3']),
      { row: 1, column: 4 },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.displacedCount).toBe(2)
    expect(result.slots).toEqual([
      { id: 'i1', row: 1, column: 4 },
      { id: 'i2', row: 1, column: 5 },
      { id: 'i3', row: 1, column: 6 },
      { id: 'blocker-a', row: 0, column: 0 },
      { id: 'blocker-b', row: 0, column: 1 },
    ])
    expect(result.slots.some((slot) => slot.id === 'bystander')).toBe(false)
  })

  it('reports zero moves when the images already form the grouped run', () => {
    const current = document([
      cell('i1', 2, 4, 'image'),
      cell('i2', 2, 5, 'image'),
      cell('other', 5, 5),
    ])
    const result = planImageGrouping(
      current,
      new Set(['i1', 'i2']),
      { row: 2, column: 4 },
    )
    expect(result).toEqual({
      ok: true,
      slots: [
        { id: 'i1', row: 2, column: 4 },
        { id: 'i2', row: 2, column: 5 },
      ],
      movedCount: 0,
      displacedCount: 0,
    })
  })

  it('fails without image cells', () => {
    const result = planImageGrouping(
      document([cell('other', 0, 0)]),
      new Set(),
      { row: 0, column: 0 },
    )
    expect(result).toEqual({
      ok: false,
      code: 'no-images',
      message: 'No image cells in this notebook to group.',
    })
  })

  it('fails when the images outnumber the grid capacity', () => {
    const images = Array.from({ length: 339 }, (_, index) =>
      cell(`i${index}`, index % 26, index % 13, 'image'))
    const result = planImageGrouping(
      document(images),
      new Set(images.map((image) => image.id)),
      { row: 0, column: 0 },
    )
    expect(result).toEqual({
      ok: false,
      code: 'capacity',
      message: 'Cannot group 339 images: the grid fits 338.',
    })
  })

  it('reports a full grid when more cells are displaced than free slots remain', () => {
    /* Only a document that stacks cells on one slot can displace more cells
       than the grid has room for; a well-formed board always fits. */
    const stacked = Array.from({ length: 340 }, (_, index) =>
      cell(`blocker-${index}`, 0, 0))
    const result = planImageGrouping(
      document([cell('i1', 5, 5, 'image'), ...stacked]),
      new Set(['i1']),
      { row: 0, column: 0 },
    )
    expect(result).toEqual({
      ok: false,
      code: 'grid-full',
      message: 'Notebook grid is full',
    })
  })
})
