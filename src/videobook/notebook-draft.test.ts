import { MarkerType } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import type { NotebookDocument } from 'videobook-engine'
import {
  notebookDocument,
  notebookEdges,
  notebookNodes,
} from './notebook-draft'

const source: NotebookDocument = {
  id: '018f7cf5-0d31-7d96-8c0f-800000000001',
  name: 'Story',
  cells: [{
    id: '018f7cf5-0d31-7d96-8c0f-800000000002',
    type: 'image',
    title: 'Opening',
    slot: { row: 0, column: 0 },
    prompt: 'A moon garden',
    model: 'generate_kie_gpt_image_2_text_to_image',
    entityId: '018f7cf5-0d31-7d96-8c0f-800000000003',
    inputs: { reference: 'img-moon' },
    outputArtifactId: '018f7cf5-0d31-7d96-8c0f-800000000004',
    references: [{
      id: '018f7cf5-0d31-7d96-8c0f-800000000006',
      kind: 'artifact',
      targetId: '018f7cf5-0d31-7d96-8c0f-800000000004',
      snapshot: { revision: 'working' },
      ordinal: 0,
    }],
  }],
  edges: [],
  createdAt: '2026-01-01T00:00:00.000Z',
}

describe('notebook draft conversion', () => {
  it('preserves real v2 notebook identity and cell fields across a flow round trip', () => {
    const nodes = notebookNodes(source)
    nodes[0] = {
      ...nodes[0],
      data: { ...nodes[0]!.data, prompt: 'A silver moon garden' },
    }
    const result = notebookDocument(source, nodes, notebookEdges(source))

    expect(result).toMatchObject({
      id: source.id,
      name: 'Story',
      createdAt: source.createdAt,
    })
    expect(result.cells[0]).toEqual({
      ...source.cells[0],
      slot: { row: 0, column: 0 },
      prompt: 'A silver moon garden',
    })
  })

  it('renders persisted slots without coordinate normalization', () => {
    const placed: NotebookDocument = {
      ...source,
      cells: [
        source.cells[0]!,
        {
          ...source.cells[0]!,
          id: '018f7cf5-0d31-7d96-8c0f-800000000005',
          type: 'video',
          slot: { row: 2, column: -3 },
        },
      ],
    }

    expect(notebookNodes(placed).map((node) => node.data.slot)).toEqual([
      { row: 0, column: 0 },
      { row: 2, column: -3 },
    ])
  })

  it('keeps manually created labels in ordinary draggable grid cells', () => {
    const labeled: NotebookDocument = {
      ...source,
      cells: [{
        ...source.cells[0]!,
        type: 'label',
        slot: { row: 9, column: -2 },
      }],
    }

    expect(notebookNodes(labeled)[0]).toMatchObject({
      position: { x: -560, y: 2568 },
      data: { slot: { row: 9, column: -2 } },
    })
    expect(notebookNodes(labeled)[0]?.draggable).toBeUndefined()
  })

  it('maps semantic inputs and directional source ports to workflow handles', () => {
    const target = {
      ...source.cells[0]!,
      id: '018f7cf5-0d31-7d96-8c0f-800000000005',
      type: 'video' as const,
      slot: { row: 1, column: 1 },
    }
    const connected: NotebookDocument = {
      ...source,
      cells: [source.cells[0]!, target],
      edges: [{
        id: '018f7cf5-0d31-7d96-8c0f-800000000007',
        source: source.cells[0]!.id,
        target: target.id,
        targetInput: 'reference-video',
      }],
    }

    expect(notebookNodes(connected)[0]?.data.sourcePorts).toEqual([
      'route-right-1',
    ])
    expect(notebookNodes(connected)[1]?.data.targetInputs).toEqual(['reference-video'])
    expect(notebookNodes(connected)[1]?.data.targetConnectionCount).toBe(1)
    expect(notebookEdges(connected)[0]).toMatchObject({
      sourceHandle: 'route-right-1',
      targetHandle: 'reference-video',
      type: 'busRiver',
      className: 'workflow-edge',
      data: {
        sourceSide: 'right',
        sourcePortIndex: 1,
        sourceBusOffset: 20,
        targetBusOffset: 20,
        riverOffset: 20,
        riverSide: 'right',
        directRowGutter: false,
        targetPrimary: true,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: '#72e7aa',
      },
    })
    expect(
      notebookDocument(connected, notebookNodes(connected), notebookEdges(connected)).edges,
    ).toEqual(connected.edges)
  })

  it('draws one arrowhead for a multi-input target', () => {
    const secondSource = {
      ...source.cells[0]!,
      id: '018f7cf5-0d31-7d96-8c0f-800000000008',
      slot: { row: 0, column: 1 },
    }
    const target = {
      ...source.cells[0]!,
      id: '018f7cf5-0d31-7d96-8c0f-800000000005',
      type: 'video' as const,
      slot: { row: 2, column: 0 },
    }
    const fanIn: NotebookDocument = {
      ...source,
      cells: [source.cells[0]!, secondSource, target],
      edges: [
        {
          id: '018f7cf5-0d31-7d96-8c0f-800000000009',
          source: source.cells[0]!.id,
          target: target.id,
          targetInput: 'reference-video',
        },
        {
          id: '018f7cf5-0d31-7d96-8c0f-800000000010',
          source: secondSource.id,
          target: target.id,
          targetInput: 'reference-audio',
        },
      ],
    }
    const rendered = notebookEdges(fanIn)
    const reversed = notebookEdges({
      ...fanIn,
      edges: [...fanIn.edges].reverse(),
    })

    expect(rendered.map((edge) => edge.targetHandle)).toEqual([
      'reference-video',
      'reference-audio',
    ])
    expect(rendered.filter((edge) => edge.markerEnd)).toHaveLength(1)
    expect(rendered.find((edge) => edge.markerEnd)?.id).toBe(fanIn.edges[0]?.id)
    expect(reversed.find((edge) => edge.markerEnd)?.id).toBe(fanIn.edges[0]?.id)
    expect(
      notebookNodes(fanIn).find((node) => node.id === target.id)
        ?.data.targetConnectionCount,
    ).toBe(2)
  })
})
