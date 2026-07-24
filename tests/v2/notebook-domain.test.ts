import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'

function resultJson(result: Awaited<ReturnType<ToolDef['handler']>>): unknown {
  expect(result.isError).toBeUndefined()
  return JSON.parse(result.content[0]!.text) as unknown
}

describe('v2 notebook domain tools', () => {
  let rootDir: string
  let books: BookManager

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-v2-domain-'))
    books = new BookManager({ libraryDir: join(rootDir, 'books'), objectPrefix: 'test-objects' })
    await books.ready()
  })

  afterEach(async () => {
    await books.close()
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('persists a graph of real NotebookDocument cells and edges', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const createBook = byName.get('create_book')!
    const created = resultJson(await createBook.handler({ slug: 'story' })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return

    const invoke = async (name: string, args: Record<string, unknown>) => {
      const def = byName.get(name)
      if (!def) throw new Error(`Missing ${name}`)
      return await withBookContext(
        { bookId: created.bookId, engine: managed.value.engine },
        () => def.handler({ book_id: created.bookId, ...args }),
      )
    }

    const list = resultJson(await invoke('list_notebooks', {})) as Array<{ id: string; name: string }>
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('Main')
    const notebookId = list[0]!.id

    const prompt = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'prompt',
        title: 'Opening prompt',
        position: { x: 40, y: 40 },
        prompt: 'A glowing moon garden',
      },
    })) as { id: string }
    const image = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'image',
        title: 'Opening image',
        position: { x: 360, y: 40 },
        prompt: 'A glowing moon garden',
        model: 'generate_kie_gpt_image_2_text_to_image',
      },
    })) as { id: string }

    resultJson(await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: prompt.id,
      target_cell_id: image.id,
      target_input: 'prompt',
    }))
    resultJson(await invoke('update_notebook_cell', {
      notebook_id: notebookId,
      cell_id: image.id,
      cell: { title: 'Moon garden image', position: { x: 400, y: 80 } },
    }))

    const document = resultJson(await invoke('get_notebook', { notebook_id: notebookId })) as {
      cells: Array<{ id: string; title: string; position: { x: number; y: number } }>
      edges: Array<{ source: string; target: string; targetInput: string }>
    }
    expect(document.cells).toHaveLength(2)
    expect(document.cells.find((cell) => cell.id === image.id)).toMatchObject({
      title: 'Moon garden image',
      position: { x: 400, y: 80 },
    })
    expect(document.edges).toEqual([{ source: prompt.id, target: image.id, targetInput: 'prompt', id: expect.any(String) }])
  })
})
