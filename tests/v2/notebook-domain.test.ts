import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import {
  notebookCellDefinitionFingerprint,
  notebookCellFingerprint,
  updateGenerationPlanState,
  writeGenerationPlanProvenance,
} from '../../server/src/jobs/run-notebook.js'
import { setEngineRoot, stopBookQueue } from '../../server/src/queue.js'
import { executeRelayoutNotebook } from '../../server/src/jobs/relayout-notebook.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'

function resultJson(result: Awaited<ReturnType<ToolDef['handler']>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined()
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

  it('validates creation and preview slots against the full notebook grid', () => {
    const definitions = videobookDomainDefs(scopedBookEngine, books)
    const create = definitions.find((definition) => definition.name === 'create_notebook_cell')!
    const preview = definitions.find((definition) => definition.name === 'preview_notebook_generation')!
    const id = '019bf918-1e85-7dda-a5c2-c760b8b11367'
    for (const slot of [{ row: 0, column: 0 }, { row: 26, column: 7 }, { row: 63, column: 7 }]) {
      expect(z.object(create.schema).safeParse({ book_id: id, notebook_id: id, cell: { type: 'prompt', slot } }).success).toBe(true)
      expect(z.object(preview.schema).safeParse({ book_id: id, notebook_id: id, cell_id: id,
        draft: { slot, prompt: '', provider: 'provider', model: 'model', operation: 'operation', tool: 'tool' } }).success).toBe(true)
    }
    for (const slot of [{ row: 64, column: 0 }, { row: 0, column: 8 }, { row: 0, column: 12 }, { row: -1, column: 0 }, { row: 0.5, column: 0 }]) {
      expect(z.object(create.schema).safeParse({ book_id: id, notebook_id: id, cell: { type: 'prompt', slot } }).success).toBe(false)
      expect(z.object(preview.schema).safeParse({ book_id: id, notebook_id: id, cell_id: id,
        draft: { slot, prompt: '', provider: 'provider', model: 'model', operation: 'operation', tool: 'tool' } }).success).toBe(false)
    }
  })

  it.each(['update_notebook_cell', 'set_notebook_cell_input', 'delete_notebook_cell'] as const)('checks queued %s revisions at mutation time', async (name) => {
    const created = await books.create('queued-revision')
    if (!created.ok) throw new Error(created.error.message)
    const managed = books.get(created.value.bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    const engine = managed.value.engine
    const notebookId = engine.notebooks.list()[0]!.id
    const defs = new Map(videobookDomainDefs(engine, books).map((def) => [def.name, def]))
    const invoke = (tool: string, args: Record<string, unknown>) => defs.get(tool)!.handler({ book_id: created.value.bookId, notebook_id: notebookId, ...args })
    const cells: Array<{ id: string }> = []
    for (const [column, type] of [[0, 'prompt'], [1, 'prompt'], [2, 'generate_image']] as const) {
      cells.push(resultJson(await invoke('create_notebook_cell', { cell: { type, slot: { row: 0, column }, prompt: 'A cat' } })) as { id: string })
    }
    const expected_revision = engine.head
    const results = await Promise.all(cells.slice(0, 2).map((cell, index) => invoke(name, {
      expected_revision,
      ...(name === 'update_notebook_cell' ? { cell_id: cell.id, cell: { label: `Changed ${index}` } } : {}),
      ...(name === 'delete_notebook_cell' ? { cell_id: cell.id } : {}),
      ...(name === 'set_notebook_cell_input' ? { target_cell_id: cells[2]!.id, target_input: 'prompt', source_cell_id: cell.id } : {}),
    })))
    expect(results.filter((result) => !result.isError)).toHaveLength(1)
    expect(results.filter((result) => result.isError)).toHaveLength(1)
  })

  it.each([false, true])('retains a queued cell creation during relayout with a revision guard: %s', async (guarded) => {
    const created = await books.create('queued-relayout')
    if (!created.ok) throw new Error(created.error.message)
    const managed = books.get(created.value.bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    const engine = managed.value.engine
    const notebookId = engine.notebooks.list()[0]!.id
    const create = videobookDomainDefs(engine, books).find((def) => def.name === 'create_notebook_cell')!
    const invoke = (row: number) => create.handler({ book_id: created.value.bookId, notebook_id: notebookId, cell: { type: 'prompt', prompt: 'A cat', slot: { row, column: 6 } } })
    resultJson(await invoke(12))
    const expectedRevision = engine.head
    const pending = invoke(24)
    const layout = executeRelayoutNotebook(engine, {
      type: 'relayout_notebook', bookId: created.value.bookId, notebookId,
      ...(guarded ? { expectedRevision } : {}),
    }).catch((error: unknown) => error)
    const [added, arranged] = await Promise.all([pending, layout])
    if (guarded) expect(arranged).toEqual(new Error(`Stale notebook revision: expected ${expectedRevision}`))
    else expect(arranged).toMatchObject({ changed: true, cell_count: 2 })
    const cell = resultJson(added) as { id: string }
    const graph = engine.notebooks.read(notebookId)
    if (!graph.ok) throw new Error(graph.error.message)
    expect(graph.value.cells).toHaveLength(2)
    expect(graph.value.cells.map((item) => item.id)).toContain(cell.id)
    await executeRelayoutNotebook(engine, { type: 'relayout_notebook', bookId: created.value.bookId, notebookId })
    const beforeNoop = engine.head
    expect(await executeRelayoutNotebook(engine, { type: 'relayout_notebook', bookId: created.value.bookId, notebookId, expectedRevision: beforeNoop }))
      .toMatchObject({ changed: false, revision: beforeNoop, cell_count: 2 })
    expect(engine.head).toBe(beforeNoop)
  })

  it('persists a graph of real NotebookDocument cells and edges', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const createBook = byName.get('create_book')!
    const created = resultJson(await createBook.handler({ name: 'story' })) as { bookId: string }
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
        label: 'prompt-opening',
        slot: { row: 0, column: 0 },
        prompt: 'A glowing moon garden',
      },
    })) as { id: string }
    const image = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_image',
        label: 'generate-image-opening',
        slot: { row: 0, column: 1 },
        prompt: 'A glowing moon garden',
      },
    })) as {
      id: string
      provider: string
      model: string
      operation: string
      tool: string
      output_cell?: { id: string }
    }
    expect(image).toMatchObject({
      provider: 'kie',
      model: 'NanoBananaProRequestSchema',
      operation: 'text_to_image',
      tool: 'generate_kie_nano_banana_pro_text_to_image',
    })
    expect(image.output_cell).toBeUndefined()

    resultJson(await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: prompt.id,
      target_cell_id: image.id,
      target_input: 'prompt',
    }))
    const cyclicConnection = await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: image.id,
      target_cell_id: prompt.id,
      target_input: 'input',
    })
    expect(cyclicConnection.isError).toBe(true)
    expect(cyclicConnection.content[0]?.text).toContain('would create a cycle')
    const cyclicReplacement = await invoke('set_notebook_cell_input', {
      notebook_id: notebookId,
      target_cell_id: prompt.id,
      target_input: 'input',
      source_cell_id: image.id,
    })
    expect(cyclicReplacement.isError).toBe(true)
    expect(cyclicReplacement.content[0]?.text).toContain('would create a cycle')
    resultJson(await invoke('update_notebook_cell', {
      notebook_id: notebookId,
      cell_id: image.id,
      cell: { label: 'generate-image-moon-garden', slot: { row: 1, column: 0 } },
    }))
    resultJson(await invoke('move_notebook_cells', {
      notebook_id: notebookId,
      slots: [
        { id: prompt.id, row: 1, column: 0 },
        { id: image.id, row: 0, column: 0 },
      ],
    }))

    const document = resultJson(await invoke('get_notebook', { notebook_id: notebookId })) as {
      revision: string
      cells: Array<{
        id: string
        label: string
        address: string
        slot: { row: number; column: number }
      }>
      edges: Array<{ source: string; target: string; targetInput: string }>
    }
    expect(document.cells).toHaveLength(2)
    expect(document.cells.find((cell) => cell.id === image.id)).toMatchObject({
      label: 'generate-image-moon-garden',
      address: '@a1',
      slot: { row: 0, column: 0 },
    })
    expect(document.cells.find((cell) => cell.id === prompt.id)?.slot)
      .toEqual({ row: 1, column: 0 })
    expect('grid' in document).toBe(false)
    expect(document.edges).toEqual(expect.arrayContaining([
      {
        source: prompt.id,
        target: image.id,
        targetInput: 'prompt',
        id: expect.any(String),
      },
    ]))
    expect(document.edges).toHaveLength(1)

    resultJson(await invoke('move_notebook_cells', {
      notebook_id: notebookId,
      expected_revision: document.revision,
      slots: [{ id: image.id, row: 1, column: 0 }],
    }))
    const swapped = resultJson(await invoke('get_notebook', {
      notebook_id: notebookId,
    })) as {
      revision: string
      cells: Array<{ id: string; slot: { row: number; column: number } }>
    }
    expect(swapped.cells.find((cell) => cell.id === image.id)?.slot)
      .toEqual({ row: 1, column: 0 })
    expect(swapped.cells.find((cell) => cell.id === prompt.id)?.slot)
      .toEqual({ row: 0, column: 0 })

    const staleMove = await invoke('move_notebook_cells', {
      notebook_id: notebookId,
      expected_revision: document.revision,
      slots: [{ id: image.id, row: 0, column: 0 }],
    })
    expect(staleMove.isError).toBe(true)
    expect(staleMove.content[0]?.text).toContain('Stale notebook revision')

    resultJson(await invoke('move_notebook_cells', {
      notebook_id: notebookId,
      expected_revision: swapped.revision,
      slots: [{ id: image.id, row: 0, column: 0 }],
    }))
    const collidingGroupMove = await invoke('move_notebook_cells', {
      notebook_id: notebookId,
      slots: [
        { id: image.id, row: 2, column: 2 },
        { id: prompt.id, row: 2, column: 2 },
      ],
    })
    expect(collidingGroupMove.isError).toBe(true)
    expect(collidingGroupMove.content[0]?.text).toContain('@c3 is targeted twice')

    resultJson(await invoke('move_notebook_cells', {
      notebook_id: notebookId,
      slots: [{ id: image.id, row: 63, column: 7 }],
    }))
    const expanded = resultJson(await invoke('get_notebook', {
      notebook_id: notebookId,
    })) as {
      cells: Array<{ id: string; slot: { row: number; column: number } }>
    }
    expect('grid' in expanded).toBe(false)
    expect(expanded.cells.find((cell) => cell.id === image.id)?.slot)
      .toEqual({ row: 63, column: 7 })
    expect(expanded.cells.find((cell) => cell.id === prompt.id)?.slot)
      .toEqual({ row: 1, column: 0 })

    const offGridMove = await invoke('move_notebook_cells', {
      notebook_id: notebookId,
      slots: [{ id: image.id, row: 64, column: 0 }],
    })
    expect(offGridMove.isError).toBe(true)
    expect(offGridMove.content[0]?.text).toContain('Cell slot must be within @a1-@bl8')
  })

  it('retypes only unconnected URL-download placeholders to image outputs', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'download-replacement',
    })) as { bookId: string }
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
    const notebooks = resultJson(await invoke('list_notebooks', {})) as Array<{ id: string }>
    const notebookId = notebooks[0]!.id
    const video = await managed.value.engine.artifacts.create('video', 'download placeholder')
    const image = await managed.value.engine.artifacts.create('image', 'download fallback')
    expect(video.ok).toBe(true)
    expect(image.ok).toBe(true)
    if (!video.ok || !image.ok) return
    const cell = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'video',
        slot: { row: 0, column: 0 },
        inputs: {
          sourceOperation: 'download_video',
          sourceUrl: 'https://example.com/post',
        },
        output_artifact_id: video.value.artifactId,
      },
    })) as { id: string }

    resultJson(await invoke('update_notebook_cell', {
      notebook_id: notebookId,
      cell_id: cell.id,
      cell: {
        type: 'image',
        output_artifact_id: image.value.artifactId,
      },
    }))
    const updated = resultJson(await invoke('get_notebook', {
      notebook_id: notebookId,
    })) as {
      cells: Array<{
        id: string
        type: string
        inputs: Record<string, unknown>
        output_artifact_id: string
      }>
    }
    expect(updated.cells.find((candidate) => candidate.id === cell.id))
      .toMatchObject({
        type: 'image',
        inputs: {
          sourceOperation: 'download_video',
          sourceUrl: 'https://example.com/post',
        },
        output_artifact_id: image.value.artifactId,
      })

    const connectedVideo = await managed.value.engine.artifacts.create(
      'video',
      'connected placeholder',
    )
    const connectedImage = await managed.value.engine.artifacts.create(
      'image',
      'connected fallback',
    )
    expect(connectedVideo.ok).toBe(true)
    expect(connectedImage.ok).toBe(true)
    if (!connectedVideo.ok || !connectedImage.ok) return
    const connectedCell = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'video',
        slot: { row: 0, column: 1 },
        inputs: { sourceOperation: 'download_video' },
        output_artifact_id: connectedVideo.value.artifactId,
      },
    })) as { id: string }
    const extractAudio = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'extract_audio',
        slot: { row: 1, column: 1 },
      },
    })) as { id: string }
    resultJson(await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: connectedCell.id,
      target_cell_id: extractAudio.id,
      target_input: 'video',
    }))
    const rejected = await invoke('update_notebook_cell', {
      notebook_id: notebookId,
      cell_id: connectedCell.id,
      cell: {
        type: 'image',
        output_artifact_id: connectedImage.value.artifactId,
      },
    })
    expect(rejected.isError).toBe(true)
    expect(rejected.content[0]?.text).toContain(
      'Cell type cannot be changed after creation',
    )
  })

  it('deletes a ready generation cell with execution and plan state', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'delete-generated-cell',
    })) as { bookId: string }
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
    const notebooks = resultJson(await invoke('list_notebooks', {})) as Array<{ id: string }>
    const notebookId = notebooks[0]!.id
    const source = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'prompt',
        label: 'prompt-source',
        slot: { row: 0, column: 0 },
        prompt: 'Source prompt',
      },
    })) as { id: string }
    const generated = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_image',
        label: 'generate-image-ready',
        slot: { row: 0, column: 1 },
        prompt: 'Generated image',
      },
    })) as { id: string; output_cell?: { id: string } }
    resultJson(await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: source.id,
      target_cell_id: generated.id,
      target_input: 'prompt',
    }))

    const notebook = managed.value.engine.notebooks.read(notebookId)
    expect(notebook.ok).toBe(true)
    if (!notebook.ok) return
    const written = await managed.value.engine.notebooks.write({
      ...notebook.value,
      execution: {
        [generated.id]: {
          status: 'ready',
          tool: 'generate_kie_gpt_image_2_text_to_image',
        },
      },
      generationPlans: [{
        planId: 'ready-generation-plan',
        cellId: generated.id,
        status: 'awaiting-output',
        plan: { cellId: generated.id },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(1).toISOString(),
      }],
    })
    expect(written.ok).toBe(true)
    if (!written.ok) return

    resultJson(await invoke('delete_notebook_cell', {
      notebook_id: notebookId,
      cell_id: generated.id,
    }))
    const deleted = resultJson(await invoke('get_notebook', {
      notebook_id: notebookId,
    })) as {
      cells: Array<{ id: string }>
      edges: Array<{ source: string; target: string }>
      execution?: Record<string, unknown>
      generationPlans?: Array<{ cellId: string }>
    }
    expect(deleted.cells.map((cell) => cell.id)).toEqual([source.id])
    expect(deleted.edges).toEqual([])
    expect(deleted.execution?.[generated.id]).toBeUndefined()
    expect(deleted.generationPlans).toEqual([])
  })

  it('enforces video action inputs and typed media outputs', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'typed-actions',
    })) as { bookId: string }
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
    const notebooks = resultJson(await invoke('list_notebooks', {})) as Array<{ id: string }>
    const notebookId = notebooks[0]!.id
    const createCell = async (
      type: string,
      label: string,
      row: number,
      column: number,
    ) => resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: { type, label, slot: { row, column } },
    })) as {
      id: string
      type?: string
      operation?: string
      output_cell?: {
        id: string
        type: string
        label: string
        address: string
        slot: { row: number; column: number }
        inputs?: Record<string, unknown>
      }
      output_edge?: {
        source: string
        target: string
        targetInput: string
      }
    }

    const sourceVideo = await createCell('video', 'vid-source', 0, 0)
    const sourceAudio = await createCell('audio', 'aud-source', 0, 1)
    const extractAudio = await createCell('extract_audio', 'extract-audio-source', 1, 0)
    const splitVideo = await createCell('split_video', 'split-video-source', 1, 2)
    const videoOutput = await createCell('video', 'vid-output', 2, 1)
    const frameImage = await createCell('image', 'frame-image', 1, 3)
    const invalidImage = await createCell('image', 'img-invalid', 3, 2)

    expect(["audio", "extract_audio"]).toContain(extractAudio.type)
    expect(extractAudio.output_cell).toBeUndefined()
    expect(extractAudio.output_edge).toBeUndefined()
    const createdNotebook = resultJson(await invoke('get_notebook', {
      notebook_id: notebookId,
    })) as {
      cells: Array<{ id: string; type: string }>
      edges: Array<{ source: string; target: string; targetInput: string }>
    }
    expect(createdNotebook.cells.filter((cell) =>
      cell.id === extractAudio.id)).toEqual([
      expect.objectContaining({ id: extractAudio.id, type: 'audio' }),
    ])
    expect(createdNotebook.cells.filter((cell) => cell.type === 'audio')).toHaveLength(2)
    expect(createdNotebook.cells.some((cell) =>
      cell.type === 'image'
      && cell.id !== invalidImage.id
      && cell.id !== frameImage.id)).toBe(false)
    expect(createdNotebook.edges.some((edge) =>
      edge.source === extractAudio.id
      && edge.targetInput === 'media')).toBe(false)
    expect(splitVideo.operation).toBe('split_range')
    const retypedAction = await invoke('update_notebook_cell', {
      notebook_id: notebookId,
      cell_id: extractAudio.id,
      cell: { type: 'split_video' },
    })
    expect(retypedAction.isError).toBe(true)
    expect(retypedAction.content[0]?.text).toContain(
      'Cell type cannot be changed after creation',
    )

    const passiveSource = await invoke('run_notebook_cell', {
      notebook_id: notebookId,
      cell_id: sourceVideo.id,
    })
    expect(passiveSource.isError).toBe(true)
    expect(passiveSource.content[0]?.text).toContain('passive outputs')

    const invalidInput = await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: sourceAudio.id,
      target_cell_id: extractAudio.id,
      target_input: 'segment',
    })
    expect(invalidInput.isError).toBe(true)
    expect(invalidInput.content[0]?.text).toMatch(/video-producing source|video input/)

    const invalidFrameInput = await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: sourceAudio.id,
      target_cell_id: frameImage.id,
      target_input: 'segment',
    })
    expect(invalidFrameInput.isError).toBe(true)
    expect(invalidFrameInput.content[0]?.text).toContain('video-producing source')

    for (const connection of [
      {
        source_cell_id: sourceVideo.id,
        target_cell_id: extractAudio.id,
        target_input: 'video',
      },
      {
        source_cell_id: sourceVideo.id,
        target_cell_id: splitVideo.id,
        target_input: 'video',
      },
      {
        source_cell_id: splitVideo.id,
        target_cell_id: videoOutput.id,
        target_input: 'media',
      },
      {
        source_cell_id: sourceVideo.id,
        target_cell_id: frameImage.id,
        target_input: 'segment',
      },
    ]) {
      resultJson(await invoke('connect_notebook_cells', {
        notebook_id: notebookId,
        ...connection,
      }))
    }

    const invalidExtractActionSource = await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: frameImage.id,
      target_cell_id: invalidImage.id,
      target_input: 'input',
    })
    expect(invalidExtractActionSource.isError).toBe(true)
    expect(invalidExtractActionSource.content[0]?.text).toContain(
      'Image cells accept media or segment inputs',
    )

    const invalidOutput = await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: extractAudio.id,
      target_cell_id: videoOutput.id,
      target_input: 'media',
    })
    expect(invalidOutput.isError).toBe(true)
    expect(invalidOutput.content[0]?.text).toContain('split video or generate video source')

    const invalidImageOutput = await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: extractAudio.id,
      target_cell_id: invalidImage.id,
      target_input: 'media',
    })
    expect(invalidImageOutput.isError).toBe(true)
    expect(invalidImageOutput.content[0]?.text).toContain('generate image source')

    const bypassedMedia = await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: splitVideo.id,
      target_cell_id: extractAudio.id,
      target_input: 'video',
    })
    expect(bypassedMedia.isError).toBe(true)
    expect(bypassedMedia.content[0]?.text).toContain('video-producing source')

    const bypassedFrameMedia = await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: splitVideo.id,
      target_cell_id: invalidImage.id,
      target_input: 'segment',
    })
    expect(bypassedFrameMedia.isError).toBe(true)
    expect(bypassedFrameMedia.content[0]?.text).toContain('video-producing source')

    const cached = await managed.value.engine.artifacts.create('video', 'cached output')
    expect(cached.ok).toBe(true)
    if (!cached.ok) return
    resultJson(await invoke('update_notebook_cell', {
      notebook_id: notebookId,
      cell_id: videoOutput.id,
      cell: { output_artifact_id: cached.value.artifactId },
    }))
    const rejectedReplacement = await invoke('set_notebook_cell_input', {
      notebook_id: notebookId,
      target_cell_id: videoOutput.id,
      target_input: 'media',
      source_cell_id: extractAudio.id,
    })
    expect(rejectedReplacement.isError).toBe(true)

    const replacement = await createCell(
      'split_video',
      'split-video-replacement',
      3,
      1,
    )
    resultJson(await invoke('set_notebook_cell_input', {
      notebook_id: notebookId,
      target_cell_id: videoOutput.id,
      target_input: 'media',
      source_cell_id: replacement.id,
    }))
    const replaced = resultJson(await invoke('get_notebook', {
      notebook_id: notebookId,
    })) as {
      cells: Array<{
        id: string
        inputs?: Record<string, unknown>
        output_artifact_id?: string
      }>
      edges: Array<{ source: string; target: string; targetInput: string }>
      execution?: Record<string, { stale?: boolean }>
    }
    expect(replaced.edges.filter((edge) =>
      edge.target === videoOutput.id && edge.targetInput === 'media'))
      .toEqual([expect.objectContaining({ source: replacement.id })])
    expect(replaced.cells.find((cell) => cell.id === videoOutput.id)).toMatchObject({
      inputs: { state: 'pending' },
    })
    expect(replaced.cells.find((cell) => cell.id === videoOutput.id))
      .not.toHaveProperty('output_artifact_id')
    expect(replaced.execution?.[videoOutput.id]?.stale).toBe(true)

    resultJson(await invoke('set_notebook_cell_input', {
      notebook_id: notebookId,
      target_cell_id: videoOutput.id,
      target_input: 'media',
      source_cell_id: null,
    }))
    const cleared = resultJson(await invoke('get_notebook', {
      notebook_id: notebookId,
    })) as { edges: Array<{ target: string; targetInput: string }> }
    expect(cleared.edges.some((edge) =>
      edge.target === videoOutput.id && edge.targetInput === 'media')).toBe(false)

    resultJson(await invoke('delete_notebook_cell', {
      notebook_id: notebookId,
      cell_id: sourceVideo.id,
    }))
    const deleted = resultJson(await invoke('get_notebook', {
      notebook_id: notebookId,
    })) as {
      cells: Array<{ id: string }>
      edges: Array<{ source: string; target: string }>
    }
    expect(deleted.cells.some((cell) => cell.id === sourceVideo.id)).toBe(false)
    expect(deleted.edges.some((edge) =>
      edge.source === sourceVideo.id || edge.target === sourceVideo.id)).toBe(false)
  })

  it('cancels a queued persistent job explicitly', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({ name: 'cancel-job' })) as {
      bookId: string
    }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const queued = managed.value.engine.jobs.queue.enqueue({
      type: 'semantic_index',
      payload: {
        type: 'semantic_index',
        bookId: created.bookId,
        assetId: '019f94ce-bc08-7428-8a9c-8da26066141c',
      },
      dedupeKey: 'cancel-me',
    })
    const cancelled = resultJson(await withBookContext(
      { bookId: created.bookId, engine: managed.value.engine },
      () => byName.get('cancel_job')!.handler({
        book_id: created.bookId,
        job_id: queued.job.id,
      }),
    )) as { id: number; state: string; error: { message: string } }
    expect(cancelled).toMatchObject({
      id: queued.job.id,
      state: 'aborted',
      error: { message: 'Cancelled by user' },
    })
  })

  it('adds and removes empty canonical sequence tracks', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'track-lifecycle',
    })) as { bookId: string }
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

    const initial = resultJson(await invoke('get_primary_sequence', {})) as {
      revision: string
      tracks: Array<{ trackId: string; kind: string; name: string; ordinal: number }>
    }
    const added = resultJson(await invoke('add_sequence_track', {
      kind: 'video',
      name: 'B-roll',
    })) as typeof initial
    const addedTrack = added.tracks.find((track) => track.name === 'B-roll')
    expect(added.revision).not.toBe(initial.revision)
    expect(addedTrack).toMatchObject({
      kind: 'video',
      ordinal: initial.tracks.filter((track) => track.kind === 'video').length,
    })

    const removed = resultJson(await invoke('remove_sequence_track', {
      track_id: addedTrack!.trackId,
    })) as typeof initial
    expect(removed.revision).not.toBe(added.revision)
    expect(removed.tracks.some((track) => track.trackId === addedTrack!.trackId)).toBe(false)
    expect(removed.tracks).toHaveLength(initial.tracks.length)
  })

  it('round-trips semantic cells, typed references, and pinned search results', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({ name: 'semantic-story' })) as {
      bookId: string
    }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const notebookId = managed.value.engine.notebooks.list()[0]!.id
    const artifact = await managed.value.engine.artifacts.create('video', 'interview')
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    const file = await managed.value.engine.files.write(
      artifact.value.artifactId,
      'original.mp4',
      Buffer.from('semantic video bytes'),
    )
    expect(file.ok).toBe(true)
    if (!file.ok) return
    const manifest = await managed.value.engine.files.manifest(artifact.value.artifactId)
    expect(manifest.ok).toBe(true)
    if (!manifest.ok) return
    const objectHash = manifest.value.files[0]?.objectHash
    expect(objectHash).toBeTruthy()
    if (!objectHash) return
    const stream = await managed.value.engine.streams.register({
      artifactId: artifact.value.artifactId,
      sourcePath: 'original.mp4',
      objectHash,
      streamIndex: 0,
      kind: 'video',
      timeBase: { numerator: 1, denominator: 1_000 },
      durationTicks: 12_000,
      codec: 'h264',
      video: {
        width: 1920,
        height: 1080,
        rotationDegrees: 0,
        pixelAspect: { numerator: 1, denominator: 1 },
        nominalFrameRate: { numerator: 30, denominator: 1 },
      },
    })
    expect(stream.ok, stream.ok ? '' : JSON.stringify(stream.error)).toBe(true)
    if (!stream.ok) return

    const invoke = async (name: string, args: Record<string, unknown>) => {
      const def = byName.get(name)
      if (!def) throw new Error(`Missing ${name}`)
      return await withBookContext(
        { bookId: created.bookId, engine: managed.value.engine },
        () => def.handler({ book_id: created.bookId, ...args }),
      )
    }
    const revision = managed.value.engine.head
    const referenceId = managed.value.engine.notebooks.createCell({
      type: 'prompt',
      label: 'prompt-reference-id',
      slot: { row: 0, column: 0 },
    }).id
    const resultId = managed.value.engine.notebooks.createCell({
      type: 'prompt',
      label: 'prompt-result-id',
      slot: { row: 0, column: 0 },
    }).id
    const cell = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'video',
        label: 'vid-warm-interview-moments',
        slot: { row: 0, column: 0 },
        references: [{
          id: referenceId,
          kind: 'stream',
          target_id: stream.value.streamId,
          snapshot: { objectHash },
          ordinal: 0,
        }],
        pinned_results: [{
          id: resultId,
          artifact_id: artifact.value.artifactId,
          object_hash: objectHash,
          location: {
            kind: 'timed',
            artifactId: artifact.value.artifactId,
            range: {
              streamId: stream.value.streamId,
              objectHash,
              startTick: 2_000,
              durationTicks: 3_000,
              timeBase: { numerator: 1, denominator: 1_000 },
            },
          },
          representative_tick: 3_000,
          query: { kind: 'text', text: 'warm interview' },
          signals: [{ kind: 'visual', rank: 1, score: 0.93 }],
          selected_revision: revision,
          ordinal: 0,
          created_at: 1,
        }],
      },
    })) as {
      type: string
      references: Array<{ id: string; target_id: string }>
      pinned_results: Array<{ id: string; selected_revision: string }>
    }

    expect(cell.type).toBe('video')
    expect(cell.references).toEqual([expect.objectContaining({
      id: referenceId,
      target_id: stream.value.streamId,
    })])
    expect(cell.pinned_results).toEqual([expect.objectContaining({
      id: resultId,
      selected_revision: revision,
    })])
    const stored = managed.value.engine.notebooks.read(notebookId)
    expect(stored.ok).toBe(true)
    if (!stored.ok) return
    expect(stored.value.cells[0]?.references?.[0]?.targetId).toBe(stream.value.streamId)
    expect(stored.value.cells[0]?.pinnedResults?.[0]?.artifactId).toBe(artifact.value.artifactId)
  })

  it('accepts a target plan when a stale paid prerequisite has saved media', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'stale-paid-prerequisite',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const notebook = engine.notebooks.list()[0]!
    const upstreamOutput = await engine.artifacts.create('image', 'Saved prerequisite')
    expect(upstreamOutput.ok).toBe(true)
    if (!upstreamOutput.ok) return
    const upstream = engine.notebooks.createCell({
      type: 'generate_image',
      label: 'Paid prerequisite',
      slot: { row: 0, column: 0 },
      prompt: 'An establishing frame',
      provider: 'kie',
      model: 'NanoBananaProRequestSchema',
      operation: 'text_to_image',
      tool: 'generate_kie_nano_banana_pro_text_to_image',
      outputArtifactId: upstreamOutput.value.artifactId,
    })
    const target = engine.notebooks.createCell({
      type: 'generate_image',
      label: 'Paid target',
      slot: { row: 1, column: 0 },
      prompt: 'A continuation frame',
      provider: 'kie',
      model: 'NanoBananaProRequestSchema',
      operation: 'text_to_image',
      tool: 'generate_kie_nano_banana_pro_text_to_image',
    })
    const document = {
      ...notebook,
      cells: [upstream, target],
      edges: [engine.notebooks.createEdge({
        source: upstream.id,
        target: target.id,
        targetInput: 'image',
      })],
    }
    const plan = {
      planId: 'target-only-generation-plan',
      cellDefinitionFingerprint: notebookCellDefinitionFingerprint(document, target),
      stages: [{ kind: 'queued', input: { cell_id: target.id } }],
    }
    const now = new Date(0).toISOString()
    const written = await engine.notebooks.write({
      ...document,
      execution: {
        [upstream.id]: {
          fingerprint: 'stale-upstream-fingerprint',
          status: 'completed',
          outputArtifactId: upstreamOutput.value.artifactId,
        },
      },
      generationPlans: [{
        planId: plan.planId,
        cellId: target.id,
        status: 'planned',
        plan,
        createdAt: now,
        updatedAt: now,
      }],
    })
    expect(written.ok).toBe(true)
    if (!written.ok) return
    const run = byName.get('run_notebook_cell')!

    await setEngineRoot(rootDir, engine)
    try {
      const result = await withBookContext(
        { bookId: created.bookId, engine },
        () => run.handler({
          book_id: created.bookId,
          notebook_id: notebook.id,
          cell_id: target.id,
          plan,
        }),
      )

      const queued = resultJson(result) as {
        job_id: string
        plan_id: string
        output_cell_id: string
      }
      expect(queued.plan_id).toBe(plan.planId)
      expect(queued.output_cell_id).toEqual(expect.any(String))
      expect(engine.jobs.queue.list({ type: 'run_notebook' })).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            cellIds: [target.id],
            force: true,
            jobId: queued.job_id,
            outputCellId: queued.output_cell_id,
          }),
        }),
      ])
      const persisted = engine.notebooks.read(notebook.id)
      expect(persisted.ok).toBe(true)
      if (!persisted.ok) return
      expect(persisted.value.execution?.[upstream.id]).toMatchObject({
        fingerprint: 'stale-upstream-fingerprint',
        status: 'completed',
      })
      expect(persisted.value.execution?.[target.id]).toBeUndefined()
      expect(persisted.value.execution?.[queued.output_cell_id]).toMatchObject({
        status: 'queued',
      })
      expect(persisted.value.generationPlans).toEqual([
        expect.objectContaining({
          planId: plan.planId,
          cellId: target.id,
          status: 'queued',
        }),
      ])
    } finally {
      await stopBookQueue(created.bookId)
    }
  })

  it('does not traverse through a current materialized image to stale paid history', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'materialized-image-boundary',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const notebook = engine.notebooks.list()[0]!
    const historicalOutput = await engine.artifacts.create('image', 'Historical image')
    const currentOutput = await engine.artifacts.create('image', 'Current image')
    expect(historicalOutput.ok).toBe(true)
    expect(currentOutput.ok).toBe(true)
    if (!historicalOutput.ok || !currentOutput.ok) return
    const historical = engine.notebooks.createCell({
      type: 'generate_image',
      label: 'Historical paid image',
      slot: { row: 0, column: 0 },
      prompt: 'An earlier image',
      provider: 'kie',
      model: 'NanoBananaProRequestSchema',
      operation: 'text_to_image',
      tool: 'generate_kie_nano_banana_pro_text_to_image',
      outputArtifactId: historicalOutput.value.artifactId,
    })
    const source = engine.notebooks.createCell({
      type: 'generate_image',
      label: 'Current materialized image',
      slot: { row: 1, column: 0 },
      prompt: 'The image selected by the user',
      provider: 'kie',
      model: 'NanoBananaProRequestSchema',
      operation: 'text_to_image',
      tool: 'generate_kie_nano_banana_pro_text_to_image',
      outputArtifactId: currentOutput.value.artifactId,
    })
    const target = engine.notebooks.createCell({
      type: 'generate_image',
      label: 'Combined image',
      slot: { row: 2, column: 0 },
      prompt: 'Combine the selected images',
      provider: 'kie',
      model: 'NanoBananaProRequestSchema',
      operation: 'text_to_image',
      tool: 'generate_kie_nano_banana_pro_text_to_image',
    })
    const document = {
      ...notebook,
      cells: [historical, source, target],
      edges: [
        engine.notebooks.createEdge({
          source: historical.id,
          target: source.id,
          targetInput: 'image',
        }),
        engine.notebooks.createEdge({
          source: source.id,
          target: target.id,
          targetInput: 'image',
        }),
      ],
    }
    const plan = {
      planId: 'materialized-image-target-plan',
      cellDefinitionFingerprint: notebookCellDefinitionFingerprint(document, target),
      stages: [{ kind: 'queued', input: { cell_id: target.id } }],
    }
    const now = new Date(0).toISOString()
    const written = await engine.notebooks.write({
      ...document,
      execution: {
        [historical.id]: {
          fingerprint: 'stale-historical-fingerprint',
          status: 'completed',
          outputArtifactId: historicalOutput.value.artifactId,
        },
        [source.id]: {
          fingerprint: notebookCellFingerprint(document, source),
          status: 'completed',
          outputArtifactId: currentOutput.value.artifactId,
        },
      },
      generationPlans: [{
        planId: plan.planId,
        cellId: target.id,
        status: 'planned',
        plan,
        createdAt: now,
        updatedAt: now,
      }],
    })
    expect(written.ok).toBe(true)
    if (!written.ok) return

    await setEngineRoot(rootDir, engine)
    try {
      const result = await withBookContext(
        { bookId: created.bookId, engine },
        () => byName.get('run_notebook_cell')!.handler({
          book_id: created.bookId,
          notebook_id: notebook.id,
          cell_id: target.id,
          plan,
        }),
      )

      const queued = resultJson(result) as { job_id: string; plan_id: string }
      expect(queued.plan_id).toBe(plan.planId)
      expect(engine.jobs.queue.list({ type: 'run_notebook' })).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            cellIds: [target.id],
            force: true,
            jobId: queued.job_id,
          }),
        }),
      ])
    } finally {
      await stopBookQueue(created.bookId)
    }
  })

  it('atomically claims one target plan and rolls it back when enqueue fails', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'enqueue-rollback',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const notebook = engine.notebooks.list()[0]!
    const target = engine.notebooks.createCell({
      type: 'generate_image',
      label: 'Paid target',
      slot: { row: 0, column: 0 },
      prompt: 'A continuation frame',
      provider: 'kie',
      model: 'NanoBananaProRequestSchema',
      operation: 'text_to_image',
      tool: 'generate_kie_nano_banana_pro_text_to_image',
    })
    const document = { ...notebook, cells: [target] }
    const plan = {
      planId: 'enqueue-rollback-plan',
      cellDefinitionFingerprint: notebookCellDefinitionFingerprint(document, target),
      stages: [{ kind: 'queued', input: { cell_id: target.id } }],
    }
    const now = new Date(0).toISOString()
    const written = await engine.notebooks.write({
      ...document,
      generationPlans: [{
        planId: plan.planId,
        cellId: target.id,
        status: 'planned',
        plan,
        createdAt: now,
        updatedAt: now,
      }],
    })
    expect(written.ok).toBe(true)
    if (!written.ok) return

    const invoke = () => withBookContext(
      { bookId: created.bookId, engine },
      () => byName.get('run_notebook_cell')!.handler({
        book_id: '',
        notebook_id: notebook.id,
        cell_id: target.id,
        plan,
      }),
    )
    const results = await Promise.all([invoke(), invoke()])

    expect(results.every((result) => result.isError === true)).toBe(true)
    expect(results.map((result) => result.content[0]?.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('queue payload requires bookId'),
        expect.stringMatching(/Generation plan is already (queued|failed)/),
      ]),
    )
    expect(engine.jobs.queue.list({ type: 'run_notebook' })).toEqual([])
    const persisted = engine.notebooks.read(notebook.id)
    expect(persisted.ok).toBe(true)
    if (!persisted.ok) return
    const outputCell = persisted.value.cells.find((cell) =>
      cell.inputs?.producerCellId === target.id)
    expect(outputCell).toBeTruthy()
    expect(persisted.value.execution?.[target.id]).toBeUndefined()
    expect(persisted.value.execution?.[outputCell!.id]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('queue payload requires bookId'),
    })
    const claimedRunId = persisted.value.execution?.[outputCell!.id]?.runId
    expect(claimedRunId).toEqual(expect.any(String))
    expect(persisted.value.generationPlans?.[0]).toMatchObject({
      planId: plan.planId,
      status: 'failed',
      error: expect.stringContaining('queue payload requires bookId'),
      plan: {
        executionClaim: { runId: claimedRunId, outputCellId: outputCell!.id },
      },
    })
    const reused = await invoke()
    expect(reused.isError).toBe(true)
    expect(reused.content[0]?.text).toContain('Generation plan is already failed')
  })

  it('preserves generation plans across retry, model switch, and omit', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'generation-lifecycle',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const notebookId = managed.value.engine.notebooks.list()[0]!.id
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const def = byName.get(name)
      if (!def) throw new Error(`Missing ${name}`)
      return await withBookContext(
        { bookId: created.bookId, engine: managed.value.engine },
        () => def.handler({ book_id: created.bookId, ...args }),
      )
    }
    const image = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_image',
        label: 'generate-image-opening',
        slot: { row: 0, column: 0 },
        prompt: 'A moonlit garden',
        model: 'generate_kie_gpt_image_2_text_to_image',
      },
    })) as { id: string }
    const plan = resultJson(await invoke('plan_notebook_generation', {
      notebook_id: notebookId,
      cell_id: image.id,
      source_surface: 'ui',
      actor: 'tester',
      timeline_start_frame: 12,
      duration_frames: 48,
    })) as {
      planId: string
      stages: Array<{
        kind: string
        tool: string
        provider: string
        model: string
        continuation: { destination: { timelineStartFrame: number } }
      }>
    }
    expect(plan.stages[0]).toMatchObject({
      kind: 'queued',
      tool: 'run_notebook_cell',
      provider: 'kie',
      continuation: { destination: { timelineStartFrame: 12 } },
    })
    const output = await managed.value.engine.artifacts.create('image', 'generated output')
    expect(output.ok).toBe(true)
    if (!output.ok) return
    const outputFile = await managed.value.engine.files.write(
      output.value.artifactId,
      'original.png',
      Buffer.from('generated image bytes'),
    )
    expect(outputFile.ok).toBe(true)
    if (!outputFile.ok) return
    const notebook = managed.value.engine.notebooks.read(notebookId)
    expect(notebook.ok).toBe(true)
    if (!notebook.ok) return
    const cell = notebook.value.cells.find((candidate) => candidate.id === image.id)
    expect(cell).toBeTruthy()
    if (!cell) return
    await writeGenerationPlanProvenance(
      managed.value.engine,
      {
        type: 'run_notebook',
        bookId: created.bookId,
        notebookId,
        generationPlan: plan as unknown as Record<string, unknown>,
        actor: 'tester',
        jobId: 'generation-job-1',
      },
      cell,
      output.value.artifactId,
    )
    await updateGenerationPlanState(
      managed.value.engine,
      notebookId,
      plan.planId,
      'awaiting-output',
      { outputArtifactId: output.value.artifactId },
    )
    const provenance = await managed.value.engine.metadata.artifacts.read<{
      planId: string
      provider: string
      jobId: string
      outputArtifactId: string
    }>(output.value.artifactId, 'command-plan')
    expect(provenance.ok).toBe(true)
    if (provenance.ok) {
      expect(provenance.value).toMatchObject({
        planId: plan.planId,
        provider: 'kie',
        jobId: 'generation-job-1',
        outputArtifactId: output.value.artifactId,
      })
    }
    const continuation = resultJson(await invoke('continue_notebook_generation', {
      notebook_id: notebookId,
      plan_id: plan.planId,
      actor: 'tester',
    })) as {
      parentActionId: string
      stages: Array<{ intent: { operations: Array<{ kind: string }> } }>
    }
    expect(continuation).toMatchObject({
      parentActionId: plan.planId,
      stages: [{
        intent: { operations: [expect.objectContaining({ kind: 'insert-clip' })] },
      }],
    })
    const retry = resultJson(await invoke('revise_notebook_generation_plan', {
      notebook_id: notebookId,
      plan_id: plan.planId,
      action: 'retry',
      source_surface: 'slash',
      actor: 'tester',
    })) as { planId: string; parentActionId: string }
    expect(retry.planId).not.toBe(plan.planId)
    expect(retry.parentActionId).toBe(plan.planId)
    const switched = resultJson(await invoke('revise_notebook_generation_plan', {
      notebook_id: notebookId,
      plan_id: retry.planId,
      action: 'switch',
      model: 'generate_kie_nano_banana_pro_text_to_image',
      source_surface: 'chat',
      actor: 'tester',
    })) as {
      planId: string
      stages: Array<{ model: string; input: { generation_tool: string } }>
    }
    expect(switched.stages[0]).toMatchObject({
      model: 'nano-banana-pro',
      input: { generation_tool: 'generate_kie_nano_banana_pro_text_to_image' },
    })
    resultJson(await invoke('revise_notebook_generation_plan', {
      notebook_id: notebookId,
      plan_id: switched.planId,
      action: 'omit',
      source_surface: 'ui',
      actor: 'tester',
    }))
    const plans = resultJson(await invoke('list_notebook_generation_plans', {
      notebook_id: notebookId,
    })) as Array<{ planId: string; status: string }>
    expect(plans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        planId: plan.planId,
        status: 'continued',
        outputArtifactId: output.value.artifactId,
      }),
      expect.objectContaining({ planId: retry.planId, status: 'planned' }),
      expect.objectContaining({ planId: switched.planId, status: 'omitted' }),
    ]))
  })
})
