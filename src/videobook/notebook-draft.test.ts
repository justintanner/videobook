import { MarkerType } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import type { NotebookDocument } from 'videobook-engine'
import {
  notebookDocument,
  notebookEdges,
  notebookNodes,
} from './notebook-draft'
import { notebookGridPosition } from './notebook-grid'

const source: NotebookDocument = {
  id: '018f7cf5-0d31-7d96-8c0f-800000000001',
  name: 'Story',
  cells: [{
    id: '018f7cf5-0d31-7d96-8c0f-800000000002',
    type: 'image',
    title: 'Opening',
    position: { x: 10, y: 20 },
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
      position: { x: 30, y: 40 },
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
      position: notebookGridPosition({ stage: 0, column: 0 }),
      prompt: 'A silver moon garden',
    })
  })

  it('separates persisted cells whose cards overlap', () => {
    const overlapping: NotebookDocument = {
      ...source,
      cells: [
        source.cells[0]!,
        {
          ...source.cells[0]!,
          id: '018f7cf5-0d31-7d96-8c0f-800000000005',
          type: 'video',
          position: { x: 30, y: 40 },
        },
      ],
    }

    expect(notebookNodes(overlapping).map((node) => node.position)).toEqual([
      notebookGridPosition({ stage: 0, column: 0 }),
      notebookGridPosition({ stage: 0, column: 1 }),
    ])
  })

  it('maps semantic inputs to visible directed workflow handles', () => {
    const target = {
      ...source.cells[0]!,
      id: '018f7cf5-0d31-7d96-8c0f-800000000005',
      type: 'video' as const,
      position: { x: 360, y: 400 },
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

    expect(notebookNodes(connected)[1]?.data.targetInputs).toEqual(['reference-video'])
    expect(notebookEdges(connected)[0]).toMatchObject({
      targetHandle: 'reference-video',
      type: 'smoothstep',
      className: 'workflow-edge',
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: '#72e7aa',
      },
    })
  })
})
