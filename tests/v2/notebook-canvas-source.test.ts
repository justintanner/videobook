import type { NotebookDocument } from 'videobook-engine'
import { describe, expect, it } from 'vitest'
import { canvasNodes } from '../../src/videobook/notebook-canvas'

function notebook(): NotebookDocument {
  return {
    id: '019f0000-0000-7000-8000-000000000034',
    name: 'Source chips',
    createdAt: new Date(0).toISOString(),
    cells: [
      { id: 'producer', type: 'generate_image', slot: { row: 1, column: 0 } },
      { id: 'output', type: 'image', slot: { row: 1, column: 1 } },
    ],
    edges: [],
  }
}

function outputAddress(document: NotebookDocument) {
  return canvasNodes(document, [], []).find((node) => node.id === 'output')?.data.producerAddress
}

describe('canvas media source address', () => {
  it('resolves producer identity and follows grid moves', () => {
    const document = notebook()
    document.cells[1].inputs = { producerCellId: 'producer' }
    expect(outputAddress(document)).toBe('@b1')
    document.cells[0].slot = { row: 2, column: 3 }
    expect(outputAddress(document)).toBe('@c4')
  })

  it('resolves a media edge without producer inputs', () => {
    const document = notebook()
    document.edges = [{ id: 'media', source: 'producer', target: 'output', targetInput: 'media' }]
    expect(outputAddress(document)).toBe('@b1')
  })

  it('omits missing producers and imported media', () => {
    const document = notebook()
    expect(outputAddress(document)).toBeUndefined()
    document.cells[1].inputs = { producerCellId: 'deleted' }
    expect(outputAddress(document)).toBeUndefined()
  })
})

describe('canvas running takes', () => {
  function generationNotebook(): NotebookDocument {
    return {
      id: '019f0000-0000-7000-8000-000000000035',
      name: 'Running takes',
      createdAt: new Date(0).toISOString(),
      cells: [
        { id: 'gen', type: 'generate_video', slot: { row: 1, column: 1 } },
        { id: 'take-1', type: 'video', slot: { row: 3, column: 2 } },
        { id: 'take-2', type: 'video', slot: { row: 4, column: 2 } },
        { id: 'take-3', type: 'video', slot: { row: 5, column: 2 }, outputArtifactId: 'artifact-3' },
      ],
      edges: ['take-1', 'take-2', 'take-3'].map((target) => ({
        id: `gen-${target}`,
        source: 'gen',
        target,
        targetInput: 'media',
      })),
      execution: {
        'take-1': { status: 'generating', startedAt: '2026-11-24T10:01:00.000Z' },
        'take-2': { status: 'queued', startedAt: '2026-11-24T10:00:00.000Z' },
      },
    }
  }

  function runningTakes(document: NotebookDocument) {
    return canvasNodes(document, [], []).find((node) => node.id === 'gen')?.data.runningTakes
  }

  it('counts the gen cell outputs still in flight and keeps the earliest start', () => {
    expect(runningTakes(generationNotebook())).toEqual({
      count: 2,
      startedAt: '2026-11-24T10:00:00.000Z',
    })
  })

  it('leaves the gen cell alone once every take has landed', () => {
    const document = generationNotebook()
    document.execution = {}
    expect(runningTakes(document)).toBeUndefined()
  })

  it('ignores links that are not generation outputs', () => {
    const document = generationNotebook()
    document.edges = document.edges.map((edge) => ({ ...edge, targetInput: 'image1' }))
    expect(runningTakes(document)).toBeUndefined()
  })
})
