import { describe, expect, it } from 'vitest'
import type { NotebookDocument } from 'videobook-engine'
import {
  notebookDocument,
  notebookEdges,
  notebookNodes,
} from './notebook-draft'

const source: NotebookDocument = {
  id: 'nb-story',
  name: 'Story',
  version: 2,
  cells: [
    {
      id: 'prompt-1',
      type: 'prompt',
      title: 'Opening',
      position: { x: 10, y: 20 },
      prompt: 'A moon garden',
      model: 'nano-banana',
      entityId: 'prm-opening',
      inputs: { reference: 'img-moon' },
      outputAssetId: 'img-opening',
    },
  ],
  edges: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
}

describe('notebook draft conversion', () => {
  it('preserves notebook identity and cell fields across a flow round trip', () => {
    const nodes = notebookNodes(source)
    nodes[0] = {
      ...nodes[0],
      position: { x: 30, y: 40 },
      data: { ...nodes[0]!.data, prompt: 'A silver moon garden' },
    }
    const result = notebookDocument(
      source,
      nodes,
      notebookEdges(source),
      '2026-01-03T00:00:00.000Z',
    )
    expect(result).toMatchObject({
      id: 'nb-story',
      name: 'Story',
      version: 2,
      createdAt: source.createdAt,
      updatedAt: '2026-01-03T00:00:00.000Z',
    })
    expect(result.cells[0]).toEqual({
      ...source.cells[0],
      position: { x: 30, y: 40 },
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
          id: 'image-1',
          type: 'image',
          position: { x: 30, y: 40 },
        },
      ],
    }

    expect(notebookNodes(overlapping).map((node) => node.position)).toEqual([
      { x: 10, y: 20 },
      { x: 640, y: 40 },
    ])
  })
})
