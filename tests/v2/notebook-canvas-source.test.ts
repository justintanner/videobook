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
