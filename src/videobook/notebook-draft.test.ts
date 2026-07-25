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
})
