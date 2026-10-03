import { describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookEdge } from 'videobook-engine'
import {
  isValidNotebookFlowConnection,
  notebookConnectionEdges,
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

  it('allows a saved image to feed its ancestor without retaining the output loop', () => {
    const image = { ...outputImage, outputArtifactId: availableImage.id }
    const cells = [generateImage, image, availableImage]
    expect(isValidNotebookFlowConnection([outputEdge], {
      source: image.id,
      target: generateImage.id,
    }, cells)).toBe(true)
    expect(notebookConnectionEdges(cells, [outputEdge], image.id, generateImage.id)).toEqual([])
    expect(notebookCyclicInputMentionValues(cells, [outputEdge], generateImage.id))
      .toEqual(new Set(['@e7']))
  })

  it('removes every path into a reused image while preserving unrelated branches and inputs', () => {
    const image = { ...outputImage, outputArtifactId: availableImage.id }
    const intermediate = { ...availableImage, id: 'intermediate', type: 'video' as const }
    const unrelated = { ...availableImage, id: 'unrelated' }
    const alternate = { ...outputEdge, id: 'alternate', source: intermediate.id }
    const branch = { ...outputEdge, id: 'branch', target: intermediate.id }
    const independent = { ...outputEdge, id: 'independent', source: unrelated.id }
    const edges = [outputEdge, alternate, branch, independent]
    const cells = [generateImage, image, intermediate, unrelated]
    const retained = notebookConnectionEdges(cells, edges, image.id, generateImage.id)
    expect(retained).toEqual([branch, independent])
    expect(edges).toEqual([outputEdge, alternate, branch, independent])
    expect(notebookConnectionWouldCreateCycle(retained!, image.id, generateImage.id)).toBe(false)
    expect(notebookConnectionEdges(cells, edges, generateImage.id, generateImage.id)).toBeNull()
    expect(notebookConnectionEdges(cells, edges, intermediate.id, generateImage.id)).toBeNull()
  })
})
