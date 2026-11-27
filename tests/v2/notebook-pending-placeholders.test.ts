import { describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import { canvasNodes } from '../../src/videobook/notebook-canvas.js'
import {
  generationPlaceholderKind,
  generationTakePlaceholderSlot,
  nodesWithPendingPlaceholders,
  pendingDownloadUrl,
  pendingPlaceholderId,
  type PendingPlaceholder,
} from '../../src/videobook/notebook-pending-placeholders.js'
import { notebookCellIsActiveStatus } from '../../src/videobook/notebook-cell-presentation.js'

const generator: NotebookCell = {
  id: 'gen',
  type: 'generate_image',
  slot: { row: 0, column: 0 },
  prompt: 'a red fox',
}

const firstTake: NotebookCell = {
  id: 'take-1',
  type: 'image',
  slot: { row: 1, column: 0 },
  prompt: 'a red fox',
  inputs: { producerCellId: 'gen', mediaRole: 'generate-image-output' },
}

function notebook(cells: NotebookCell[]): NotebookDocument {
  return {
    id: 'notebook-1',
    cells,
    edges: cells
      .filter((cell) => cell.inputs?.producerCellId === 'gen')
      .map((cell) => ({ id: `gen>${cell.id}`, source: 'gen', target: cell.id, targetInput: 'media' })),
  } as NotebookDocument
}

function placeholder(extra: Partial<PendingPlaceholder> = {}): PendingPlaceholder {
  return {
    id: pendingPlaceholderId('one'),
    notebookId: 'notebook-1',
    kind: 'image',
    slot: { row: 1, column: 0 },
    status: 'queued',
    startedAt: '2026-11-27T10:00:00.000Z',
    ...extra,
  }
}

describe('pending placeholders', () => {
  it('puts a generator placeholder where its next take lands', () => {
    expect(generationTakePlaceholderSlot(notebook([generator]), generator)).toEqual({ row: 1, column: 0 })
    expect(generationTakePlaceholderSlot(notebook([generator, firstTake]), generator)).toEqual({ row: 2, column: 0 })
  })

  it('places the take of a generator the notebook has not saved yet', () => {
    const unsaved: NotebookCell = { ...generator, id: 'draft', slot: { row: 0, column: 3 } }
    expect(generationTakePlaceholderSlot(notebook([generator, firstTake]), unsaved)).toEqual({ row: 1, column: 3 })
  })

  it('shows placeholders only for image and video generators', () => {
    expect(generationPlaceholderKind('generate_image')).toBe('image')
    expect(generationPlaceholderKind('generate_video')).toBe('video')
    expect(generationPlaceholderKind('generate_audio')).toBeNull()
    expect(generationPlaceholderKind('image')).toBeNull()
  })

  it('adds an inert active tile in the placeholder slot', () => {
    const nodes = canvasNodes(notebook([generator]), [], [])
    const shown = nodesWithPendingPlaceholders(nodes, [placeholder()], 'notebook-1')
    expect(shown).toHaveLength(2)
    const tile = shown[1]!
    expect(tile).toMatchObject({
      id: 'pending:one',
      type: 'cell',
      selectable: false,
      draggable: false,
      connectable: false,
      deletable: false,
      data: { kind: 'image', pending: true, slot: { row: 1, column: 0 }, status: 'queued' },
    })
    expect(notebookCellIsActiveStatus(tile.data.status)).toBe(true)
    expect(tile.data.statusStartedAt).toBe('2026-11-27T10:00:00.000Z')
  })

  it('drops a placeholder once a real cell takes its slot', () => {
    const nodes = canvasNodes(notebook([generator, firstTake]), [], [])
    expect(nodesWithPendingPlaceholders(nodes, [placeholder()], 'notebook-1')).toBe(nodes)
  })

  it('keeps placeholders out of other notebooks and off shared slots', () => {
    const nodes = canvasNodes(notebook([generator]), [], [])
    expect(nodesWithPendingPlaceholders(nodes, [placeholder()], 'notebook-2')).toBe(nodes)
    expect(nodesWithPendingPlaceholders(nodes, [placeholder()], null)).toBe(nodes)
    const twice = [placeholder(), placeholder({ id: pendingPlaceholderId('two'), kind: 'video', status: 'downloading' })]
    expect(nodesWithPendingPlaceholders(nodes, twice, 'notebook-1').map((node) => node.id)).toEqual(['gen', 'pending:one'])
  })

  it('recognises a message that is only a link to download', () => {
    expect(pendingDownloadUrl('https://x.com/user/status/1')).toBe('https://x.com/user/status/1')
    expect(pendingDownloadUrl('  Download https://example.com/cat.png ')).toBe('https://example.com/cat.png')
    expect(pendingDownloadUrl('what is https://example.com/cat.png about?')).toBeNull()
    expect(pendingDownloadUrl('make an image of a cat')).toBeNull()
  })
})
