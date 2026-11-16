import { describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import {
  notebookCellRouteTags,
  notebookIncomingRouteBadge,
  notebookOutgoingRouteBadge,
  notebookRouteSlotLabel,
  type NotebookRouteTag,
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
  it('points each input cell at the generation it feeds and speaks the slot it fills', () => {
    const tags = notebookCellRouteTags(board)
    const photoBadge = notebookOutgoingRouteBadge(tags.get(photo.id)?.outgoing ?? [])
    const clipBadge = notebookOutgoingRouteBadge(tags.get(clip.id)?.outgoing ?? [])

    expect(photoBadge?.segments).toEqual([{ address: 'b1', slots: [], family: 'gen' }])
    expect(photoBadge?.label).toBe('Feeds @b1 as image1')
    expect(clipBadge?.segments).toEqual([{ address: 'b1', slots: [], family: 'gen' }])
    expect(clipBadge?.label).toBe('Feeds @b1 as video1')
  })

  it('shows what feeds a generation as slot keycaps coloured by the source cell', () => {
    const tags = notebookCellRouteTags(board)
    const badge = notebookIncomingRouteBadge(tags.get(generation.id)?.incoming ?? [])

    expect(badge?.segments).toEqual([
      { address: 'a1', slots: ['I1'], family: 'image' },
      { address: 'c1', slots: ['V1'], family: 'video' },
    ])
    expect(badge?.tone).toBe('mixed')
    expect(badge?.label).toBe('Fed by @a1 into image1, @c1 into video1')
  })

  it('lists every destination of a cell with several outputs', () => {
    const tags = notebookCellRouteTags(board)
    const outputs = notebookOutgoingRouteBadge(tags.get(generation.id)?.outgoing ?? [])
    const producer = notebookIncomingRouteBadge(tags.get(firstRun.id)?.incoming ?? [])

    expect(outputs?.segments).toEqual([
      { address: 'c2', slots: [], family: 'video' },
      { address: 'c3', slots: [], family: 'video' },
    ])
    expect(outputs?.label).toBe('Feeds @c2, @c3')
    expect(producer?.segments).toEqual([{ address: 'b1', slots: [], family: 'gen' }])
    expect(producer?.tone).toBe('gen')
    expect(producer?.label).toBe('Fed by @b1')
  })

  it('collapses long route lists into a count', () => {
    const many: NotebookRouteTag[] = [1, 2, 3, 4, 5].map((index) => ({
      address: `@d${index}`,
      tokens: [],
      type: 'video',
    }))
    const outputs = notebookOutgoingRouteBadge(many)
    const inputs = notebookIncomingRouteBadge(many)

    expect(outputs?.segments.map((segment) => segment.address)).toEqual(['d1'])
    expect(outputs?.hidden).toBe(4)
    expect(outputs?.label).toBe('Feeds @d1, @d2, @d3 and 2 more')
    expect(notebookOutgoingRouteBadge(many.slice(0, 2))?.segments.map((segment) => segment.address))
      .toEqual(['d1', 'd2'])
    expect(notebookOutgoingRouteBadge(many.slice(0, 3))?.hidden).toBe(2)
    expect(inputs?.segments.map((segment) => segment.address)).toEqual(['d1', 'd2', 'd3'])
    expect(inputs?.hidden).toBe(2)
    expect(inputs?.label).toBe('Fed by @d1, @d2, @d3 and 2 more')
    expect(notebookOutgoingRouteBadge([])).toBeNull()
    expect(notebookIncomingRouteBadge([])).toBeNull()
  })

  it('shortens mention tokens into keycap labels', () => {
    expect(notebookRouteSlotLabel('image2')).toBe('I2')
    expect(notebookRouteSlotLabel('video1')).toBe('V1')
    expect(notebookRouteSlotLabel('audio1')).toBe('A1')
    expect(notebookRouteSlotLabel('keyframe3')).toBe('K3')
    expect(notebookRouteSlotLabel('firstframe')).toBe('FF')
    expect(notebookRouteSlotLabel('lastframe')).toBe('LF')
    expect(notebookRouteSlotLabel('input')).toBe('INP')
  })

  it('hands route tags to the canvas nodes and leaves unconnected cells bare', () => {
    const lonely: NotebookDocument = { ...board, cells: [...board.cells, cell('018f7cf5-0d31-7d96-8c0f-8000000000a2', 'image', 0, 1)] }
    const nodes = new Map(notebookNodes(lonely).map((node) => [node.id, node.data]))

    expect(nodes.get(photo.id)?.outgoingRoutes).toEqual([
      { address: '@b1', tokens: ['image1'], type: 'generate_video' },
    ])
    expect(nodes.get('018f7cf5-0d31-7d96-8c0f-8000000000a2')?.outgoingRoutes).toEqual([])
    expect(nodes.get('018f7cf5-0d31-7d96-8c0f-8000000000a2')?.incomingRoutes).toEqual([])
  })
})
