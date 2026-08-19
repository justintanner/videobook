import { describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import { planVideoAxisArrangement } from './notebook-video-axis-arrange'

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

describe('planVideoAxisArrangement', () => {
  it('packs videos down the anchor column in reading order from the anchor', () => {
    const current = document([
      cell('v1', 5, 5, 'video'),
      cell('v2', 0, 0, 'video'),
      cell('v3', 9, 1, 'video'),
      cell('other', 3, 3),
    ])
    const result = planVideoAxisArrangement(
      current,
      new Set(['v1', 'v2', 'v3']),
      { row: 2, column: 4 },
      'column',
    )
    expect(result).toEqual({
      ok: true,
      slots: [
        { id: 'v2', row: 2, column: 4 },
        { id: 'v1', row: 3, column: 4 },
        { id: 'v3', row: 4, column: 4 },
      ],
      movedCount: 3,
      displacedCount: 0,
    })
  })

  it('packs videos across the anchor row in reading order from the anchor', () => {
    const current = document([
      cell('v1', 0, 1, 'video'),
      cell('v2', 3, 9, 'video'),
    ])
    const result = planVideoAxisArrangement(
      current,
      new Set(['v1', 'v2']),
      { row: 7, column: 2 },
      'row',
    )
    expect(result).toEqual({
      ok: true,
      slots: [
        { id: 'v1', row: 7, column: 2 },
        { id: 'v2', row: 7, column: 3 },
      ],
      movedCount: 2,
      displacedCount: 0,
    })
  })

  it('wraps to the axis start when the run passes the grid edge', () => {
    const current = document([
      cell('v1', 1, 1, 'video'),
      cell('v2', 2, 2, 'video'),
      cell('v3', 3, 3, 'video'),
      cell('v4', 4, 4, 'video'),
    ])
    const result = planVideoAxisArrangement(
      current,
      new Set(['v1', 'v2', 'v3', 'v4']),
      { row: 24, column: 0 },
      'column',
    )
    expect(result.ok && result.slots).toEqual([
      { id: 'v1', row: 24, column: 0 },
      { id: 'v2', row: 25, column: 0 },
      { id: 'v3', row: 0, column: 0 },
      { id: 'v4', row: 1, column: 0 },
    ])
  })

  it('pushes non-video cells on target slots out to free slots in reading order', () => {
    const current = document([
      cell('v1', 9, 9, 'video'),
      cell('v2', 10, 10, 'video'),
      cell('v3', 11, 11, 'video'),
      cell('blocker-a', 2, 4),
      cell('blocker-b', 3, 4),
      cell('bystander', 6, 6),
    ])
    const result = planVideoAxisArrangement(
      current,
      new Set(['v1', 'v2', 'v3']),
      { row: 1, column: 4 },
      'column',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.displacedCount).toBe(2)
    expect(result.slots).toEqual([
      { id: 'v1', row: 1, column: 4 },
      { id: 'v2', row: 2, column: 4 },
      { id: 'v3', row: 3, column: 4 },
      { id: 'blocker-a', row: 0, column: 0 },
      { id: 'blocker-b', row: 0, column: 1 },
    ])
    const targetKeys = new Set(['1:4', '2:4', '3:4'])
    const displacedSlots = result.slots.filter((slot) => slot.id.startsWith('blocker'))
    for (const slot of displacedSlots) {
      expect(targetKeys.has(`${slot.row}:${slot.column}`)).toBe(false)
    }
    expect(result.slots.some((slot) => slot.id === 'bystander')).toBe(false)
  })

  it('reports zero moves when videos already fill the axis from the anchor', () => {
    const current = document([
      cell('v1', 2, 4, 'video'),
      cell('v2', 3, 4, 'video'),
      cell('other', 5, 5),
    ])
    const result = planVideoAxisArrangement(
      current,
      new Set(['v1', 'v2']),
      { row: 2, column: 4 },
      'column',
    )
    expect(result).toEqual({
      ok: true,
      slots: [
        { id: 'v1', row: 2, column: 4 },
        { id: 'v2', row: 3, column: 4 },
      ],
      movedCount: 0,
      displacedCount: 0,
    })
  })

  it('fails without video cells', () => {
    const result = planVideoAxisArrangement(
      document([cell('other', 0, 0)]),
      new Set(),
      { row: 0, column: 0 },
      'column',
    )
    expect(result).toEqual({
      ok: false,
      code: 'no-videos',
      message: 'No video cells in this notebook to arrange.',
    })
  })

  it('fails when the videos outnumber the axis length', () => {
    const cells = Array.from({ length: 14 }, (_, index) =>
      cell(`v${index}`, index, 0, 'video'))
    const result = planVideoAxisArrangement(
      document(cells),
      new Set(cells.map((c) => c.id)),
      { row: 0, column: 0 },
      'row',
    )
    expect(result).toEqual({
      ok: false,
      code: 'capacity',
      message: 'Cannot arrange 14 videos in one row: the grid fits 13.',
    })
  })
})
