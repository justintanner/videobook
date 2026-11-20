import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'
import {
  asNotebookGenerationActions,
  initialGenerationSelection,
  type NotebookGenerationAction,
} from '../../src/videobook/notebook-generation-actions'
import {
  contextMenuGenerationLabel,
  planContextMenuGeneration,
  selectionGenerationSourceIds,
} from '../../src/videobook/notebook-selection-generation'

function resultJson(result: Awaited<ReturnType<ToolDef['handler']>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined()
  return JSON.parse(result.content[0]!.text) as unknown
}

function mediaCell(index: number, type: 'image' | 'audio' | 'video', row: number, column: number) {
  return {
    id: `01900000-0000-7000-8000-00000000008${index}`,
    type,
    slot: { row, column },
    outputArtifactId: `01900000-0000-7000-8000-00000000009${index}`,
  }
}

const right = mediaCell(1, 'image', 2, 2)
const left = mediaCell(2, 'image', 2, 0)
const middle = mediaCell(3, 'image', 2, 1)
const audio = mediaCell(4, 'audio', 4, 0)
const video = mediaCell(5, 'video', 0, 0)
const document = {
  id: '01900000-0000-7000-8000-000000000080',
  name: 'selection-generation',
  createdAt: '2026-01-01T00:00:00.000Z',
  cells: [right, left, middle, audio, video],
  edges: [],
}

describe('selection generation sources', () => {
  it('keeps the right-clicked cell alone unless it is part of a multi-selection', () => {
    expect(selectionGenerationSourceIds(right.id, new Set([right.id]), document.cells))
      .toEqual([right.id])
    expect(selectionGenerationSourceIds(audio.id, new Set([left.id, middle.id]), document.cells))
      .toEqual([audio.id])
  })

  it('orders a multi-selection by grid position', () => {
    expect(selectionGenerationSourceIds(right.id, new Set([right.id, left.id, middle.id]), document.cells))
      .toEqual([left.id, middle.id, right.id])
  })

  it('labels selection actions by how many cells they use', () => {
    expect(contextMenuGenerationLabel('generate_video', [right])).toBe('Generate video')
    expect(contextMenuGenerationLabel('generate_video', [left, middle, right]))
      .toBe('Generate video from 3 images')
    expect(contextMenuGenerationLabel('generate_image', [left, middle, right]))
      .toBe('Generate image from 3 images')
    expect(contextMenuGenerationLabel('generate_video', [left, audio]))
      .toBe('Generate video from 2 cells')
  })
})

describe('selection generation planning', () => {
  let rootDir: string
  let books: BookManager

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-selection-generation-'))
    books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    await books.ready()
  })

  afterEach(async () => {
    await books.close()
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  async function notebookActions(cellType: 'generate_video' | 'generate_image'): Promise<NotebookGenerationAction[]> {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: `selection-${cellType.replace('_', '-')}`,
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    return asNotebookGenerationActions(resultJson(await withBookContext(
      { bookId: created.bookId, engine: managed.value.engine },
      () => byName.get('list_notebook_actions')!.handler({ book_id: created.bookId, cell_type: cellType }),
    )))
  }

  it('plans one video generation wired to every selected image in grid order', async () => {
    const sourceCellIds = selectionGenerationSourceIds(
      right.id,
      new Set([right.id, left.id, middle.id]),
      document.cells,
    )
    const draft = planContextMenuGeneration({
      actions: await notebookActions('generate_video'),
      cellId: '01900000-0000-7000-8000-000000000089',
      cellType: 'generate_video',
      document,
      sourceCellIds,
    })
    expect(draft.cell.type).toBe('generate_video')
    expect(draft.sourceAddresses).toEqual(['@c1', '@c2', '@c3'])
    expect(draft.connections.map((connection) => connection.sourceCellId))
      .toEqual([left.id, middle.id, right.id])
  })

  it('starts a context-menu generation on the remembered model, or its same-provider sibling that takes the source', async () => {
    const savedKey = process.env.FAL_API_KEY
    process.env.FAL_API_KEY = 'test-key'
    try {
      const actions = await notebookActions('generate_video')
      const plan = (rememberedModel: string) => planContextMenuGeneration({
        actions,
        cellId: '01900000-0000-7000-8000-000000000085',
        cellType: 'generate_video',
        document,
        rememberedModel,
        sourceCellIds: [left.id],
      })
      expect(plan('fal:minimax/h3/image-to-video').action.model).toBe('fal:minimax/h3/image-to-video')
      expect(plan('fal:minimax/h3/text-to-video').action.model).toBe('fal:minimax/h3/image-to-video')
      expect(initialGenerationSelection({ type: 'generate_video' }, actions, [], 'fal:minimax/h3/text-to-video'))
        .toMatchObject({ provider: 'fal', model: 'fal:minimax/h3/text-to-video' })
      expect(initialGenerationSelection({ type: 'generate_video' }, actions, [{ kind: 'image', target: 'first_frame' }], 'fal:minimax/h3/text-to-video'))
        .toMatchObject({ provider: 'fal', model: 'fal:minimax/h3/image-to-video' })
      expect(initialGenerationSelection({ type: 'generate_video', model: 'kie:bytedance/seedance-2-5' }, actions, [], 'fal:minimax/h3/text-to-video'))
        .toMatchObject({ model: 'kie:bytedance/seedance-2-5' })
    } finally {
      if (savedKey === undefined) delete process.env.FAL_API_KEY
      else process.env.FAL_API_KEY = savedKey
    }
  })

  it('keeps the Lightning default when the remembered provider is not configured', async () => {
    const savedKey = process.env.FAL_API_KEY
    delete process.env.FAL_API_KEY
    try {
      const actions = await notebookActions('generate_video')
      expect(initialGenerationSelection({ type: 'generate_video' }, actions, [], 'fal:minimax/h3/text-to-video'))
        .toMatchObject({ model: 'kie:bytedance/seedance-2-5' })
      expect(initialGenerationSelection({ type: 'generate_video' }, actions, [], 'kie:retired-video-model'))
        .toMatchObject({ model: 'kie:bytedance/seedance-2-5' })
    } finally {
      if (savedKey !== undefined) process.env.FAL_API_KEY = savedKey
    }
  })

  it('plans one image generation from the same selection', async () => {
    const draft = planContextMenuGeneration({
      actions: await notebookActions('generate_image'),
      cellId: '01900000-0000-7000-8000-000000000088',
      cellType: 'generate_image',
      document,
      sourceCellIds: [left.id, middle.id, right.id],
    })
    expect(draft.cell.type).toBe('generate_image')
    expect(draft.connections).toHaveLength(3)
  })

  it('refuses a selection that includes a cell without media output', async () => {
    const pending = { id: '01900000-0000-7000-8000-000000000087', type: 'image' as const, slot: { row: 3, column: 0 } }
    expect(() => planContextMenuGeneration({
      actions: [],
      cellId: '01900000-0000-7000-8000-000000000086',
      cellType: 'generate_video',
      document: { ...document, cells: [...document.cells, pending] },
      sourceCellIds: [left.id, pending.id],
    })).toThrow('does not have media output yet')
  })
})
