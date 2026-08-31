import { describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookEdge } from 'videobook-engine'
import {
  isValidNotebookFlowConnection,
  notebookConnectionWouldCreateCycle,
  notebookCyclicInputMentionValues,
} from '../../src/videobook/notebook-graph'

const generateImage: NotebookCell = {
  id: '01900000-0000-7000-8000-000000000001',
  type: 'generate_image',
  slot: { row: 4, column: 6 },
}

const outputImage: NotebookCell = {
  id: '01900000-0000-7000-8000-000000000002',
  type: 'image',
  slot: { row: 4, column: 7 },
}

const availableImage: NotebookCell = {
  id: '01900000-0000-7000-8000-000000000003',
  type: 'image',
  slot: { row: 0, column: 0 },
}

const outputEdge: NotebookEdge = {
  id: '01900000-0000-7000-8000-000000000004',
  source: generateImage.id,
  target: outputImage.id,
  targetInput: 'media',
}

describe('notebook graph cycle guards', () => {
  it('rejects looping canvas connections before they are created', () => {
    expect(isValidNotebookFlowConnection([outputEdge], {
      source: outputImage.id,
      target: generateImage.id,
    })).toBe(false)
    expect(isValidNotebookFlowConnection([outputEdge], {
      source: generateImage.id,
      target: generateImage.id,
    })).toBe(false)
    expect(isValidNotebookFlowConnection([outputEdge], {
      source: availableImage.id,
      target: generateImage.id,
    })).toBe(true)
    expect(isValidNotebookFlowConnection([outputEdge], {
      source: null,
      target: generateImage.id,
    })).toBe(false)
  })

  it('lists descendant mention tokens that would loop back into a cell', () => {
    expect(notebookConnectionWouldCreateCycle(
      [outputEdge],
      outputImage.id,
      generateImage.id,
    )).toBe(true)
    expect(notebookCyclicInputMentionValues(
      [generateImage, outputImage, availableImage],
      [outputEdge],
      generateImage.id,
    )).toEqual(new Set(['@e7', '@e8']))
  })
})
