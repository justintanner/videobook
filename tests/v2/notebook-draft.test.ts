import type { Node } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import {
  notebookNodesWithCellStatus,
  type NotebookCellData,
} from '../../src/videobook/notebook-draft'

function cellNode(id: string, status: string): Node<NotebookCellData> {
  return {
    id,
    type: 'cell',
    position: { x: 0, y: 0 },
    data: {
      kind: 'extract_audio',
      slug: id,
      subtitle: 'EXTRACT AUDIO · CELL',
      slot: { row: 0, column: 0 },
      status,
    },
  }
}

describe('notebook draft presentation', () => {
  it('updates only the accepted run target to queued', () => {
    const target = cellNode('target-cell', 'completed')
    const neighbor = cellNode('neighbor-cell', 'completed')
    const nodes = [target, neighbor]

    const next = notebookNodesWithCellStatus(nodes, target.id, 'queued')

    expect(next).not.toBe(nodes)
    expect(next[0]).not.toBe(target)
    expect(next[0]?.data.status).toBe('queued')
    expect(next[1]).toBe(neighbor)
    expect(target.data.status).toBe('completed')
  })

  it('preserves node identity when the requested status is already visible', () => {
    const nodes = [cellNode('target-cell', 'queued')]

    expect(notebookNodesWithCellStatus(nodes, 'target-cell', 'queued')).toBe(nodes)
  })
})
