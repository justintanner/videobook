import { describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import {
  notebookCellRouteTags,
  notebookIncomingRouteText,
  notebookOutgoingRouteText,
} from './notebook-route-tags'
import { notebookNodes } from './notebook-draft'

function cell(
  id: string,
  type: NotebookCell['type'],
  row: number,
  column: number,
  inputs?: Record<string, unknown>,
): NotebookCell {
  return {
    id,
    type,
    slot: { row, column },
    ...(inputs === undefined ? {} : { inputs }),
  } as NotebookCell
}

const photo = cell('018f7cf5-0d31-7d96-8c0f-8000000000a1', 'image', 0, 0)
const generation = cell('018f7cf5-0d31-7d96-8c0f-8000000000b1', 'generate_video', 1, 0, {
  generationMode: 'r2v',
})
const clip = cell('018f7cf5-0d31-7d96-8c0f-8000000000c1', 'video', 2, 0)
const firstRun = cell('018f7cf5-0d31-7d96-8c0f-8000000000c2', 'video', 2, 1)
const secondRun = cell('018f7cf5-0d31-7d96-8c0f-8000000000c3', 'video', 2, 2)

const board: NotebookDocument = {
  id: '018f7cf5-0d31-7d96-8c0f-800000000001',
  name: 'Swing',
  cells: [photo, generation, clip, firstRun, secondRun],
  edges: [
    { id: '018f7cf5-0d31-7d96-8c0f-8000000000e1', source: photo.id, target: generation.id, targetInput: 'image' },
    { id: '018f7cf5-0d31-7d96-8c0f-8000000000e2', source: clip.id, target: generation.id, targetInput: 'video' },
    { id: '018f7cf5-0d31-7d96-8c0f-8000000000e3', source: generation.id, target: firstRun.id, targetInput: 'input' },
    { id: '018f7cf5-0d31-7d96-8c0f-8000000000e4', source: generation.id, target: secondRun.id, targetInput: 'input' },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
}

describe('notebook route tags', () => {
  it('names each input cell by the generation slot it fills', () => {
    const tags = notebookCellRouteTags(board)

    expect(notebookOutgoingRouteText(tags.get(photo.id)?.outgoing ?? [])).toBe('@b1 · image1')
    expect(notebookOutgoingRouteText(tags.get(clip.id)?.outgoing ?? [])).toBe('@b1 · video1')
  })

  it('lists every destination of a cell with several outputs', () => {
    const tags = notebookCellRouteTags(board)

    expect(notebookOutgoingRouteText(tags.get(generation.id)?.outgoing ?? [])).toBe('@c2 · @c3')
    expect(notebookIncomingRouteText(tags.get(generation.id)?.incoming ?? [])).toBe('from @a1 · @c1')
    expect(notebookIncomingRouteText(tags.get(firstRun.id)?.incoming ?? [])).toBe('from @b1')
  })

  it('collapses long route lists into a count', () => {
    const many = [1, 2, 3, 4, 5].map((index) => ({ address: `@d${index}`, tokens: [] }))

    expect(notebookOutgoingRouteText(many)).toBe('@d1 · @d2 · @d3 +2')
    expect(notebookIncomingRouteText(many)).toBe('from 5 cells')
    expect(notebookOutgoingRouteText([])).toBeNull()
    expect(notebookIncomingRouteText([])).toBeNull()
  })

  it('hands route tags to the canvas nodes and leaves unconnected cells bare', () => {
    const lonely: NotebookDocument = { ...board, cells: [...board.cells, cell('018f7cf5-0d31-7d96-8c0f-8000000000a2', 'image', 0, 1)] }
    const nodes = new Map(notebookNodes(lonely).map((node) => [node.id, node.data]))

    expect(nodes.get(photo.id)?.outgoingRoutes).toEqual([{ address: '@b1', tokens: ['image1'] }])
    expect(nodes.get('018f7cf5-0d31-7d96-8c0f-8000000000a2')?.outgoingRoutes).toEqual([])
    expect(nodes.get('018f7cf5-0d31-7d96-8c0f-8000000000a2')?.incomingRoutes).toEqual([])
  })
})
