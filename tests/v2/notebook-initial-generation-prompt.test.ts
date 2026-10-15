import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import { prepareNotebookGeneration } from '../../server/src/jobs/run-notebook.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'

function resultJson(result: Awaited<ReturnType<ToolDef['handler']>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined()
  return JSON.parse(result.content[0]!.text) as unknown
}

describe('notebook initial generation prompts', () => {
  let rootDir: string
  let books: BookManager

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-initial-prompt-'))
    books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    await books.ready()
  })

  afterEach(async () => {
    await books.close()
    await rm(rootDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    })
  })

  it('seeds image and video prompts from real connected inputs', async () => {
    const definitions = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(definitions.map((definition) => [
      definition.name,
      definition,
    ]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'prompt-story',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return

    const invoke = async (name: string, args: Record<string, unknown>) => {
      const definition = byName.get(name)
      if (!definition) throw new Error(`Missing ${name}`)
      return await withBookContext(
        { bookId: created.bookId, engine: managed.value.engine },
        () => definition.handler({ book_id: created.bookId, ...args }),
      )
    }

    const notebooks = resultJson(await invoke('list_notebooks', {})) as Array<{
      id: string
    }>
    const notebookId = notebooks[0]!.id
    const artifact = await managed.value.engine.artifacts.create(
      'image',
      'Hero portrait',
    )
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return

    const source = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'image',
        label: 'The hero portrait',
        slot: { row: 0, column: 0 },
        prompt: 'A moonlit hero portrait.',
        output_artifact_id: artifact.value.artifactId,
      },
    })) as { id: string }
    const image = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_image',
        label: 'Generate Poster image',
        slot: { row: 0, column: 1 },
        prompt: '',
      },
    })) as {
      id: string
      inputs: Record<string, unknown>
      prompt: string
    }
    const video = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_video',
        label: 'Generate Hero motion',
        slot: { row: 2, column: 0 },
        prompt: '',
        provider: 'kie',
        model: 'Seedance2InputSchema',
        operation: 'image_to_video',
        tool: 'generate_kie_seedance_2_5_video',
        inputs: { generationMode: 'r2v' },
      },
    })) as {
      id: string
      inputs: Record<string, unknown>
      prompt: string
    }

    expect(image.prompt).toBe('Clear subject, coherent scene.')
    expect(video.prompt).toBe('Clear subject, coherent motion.')
    expect(image.inputs.initialGenerationPrompt).toEqual({
      prompt: image.prompt,
      version: 1,
    })
    expect(video.inputs.initialGenerationPrompt).toEqual({
      prompt: video.prompt,
      version: 1,
    })

    resultJson(await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: source.id,
      target_cell_id: image.id,
      target_input: 'image',
    }))
    resultJson(await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: source.id,
      target_cell_id: video.id,
      target_input: 'image',
    }))

    const connected = resultJson(await invoke('get_notebook', {
      notebook_id: notebookId,
    })) as {
      cells: Array<{ id: string; prompt?: string }>
      edges: Array<{ id: string; target: string }>
    }
    expect(connected.cells.find((cell) => cell.id === image.id)?.prompt).toBe(
      'Reference image @image1: moonlit hero portrait. Preserve subject, composition. Render clean image.',
    )
    expect(connected.cells.find((cell) => cell.id === video.id)?.prompt).toBe(
      'Subject image @image1: moonlit hero portrait. Animate subject. Preserve identity, composition. Render coherent video.',
    )
    const connectedDocument = managed.value.engine.notebooks.read(notebookId)
    expect(connectedDocument.ok).toBe(true)
    if (!connectedDocument.ok) return
    const connectedImage = connectedDocument.value.cells.find((cell) =>
      cell.id === image.id)
    const connectedVideo = connectedDocument.value.cells.find((cell) =>
      cell.id === video.id)
    if (!connectedImage || !connectedVideo) {
      throw new Error('Connected generation cells are missing')
    }
    const imageRequest = await prepareNotebookGeneration(
      managed.value.engine,
      connectedDocument.value,
      connectedImage,
      created.bookId,
    )
    const videoRequest = await prepareNotebookGeneration(
      managed.value.engine,
      connectedDocument.value,
      connectedVideo,
      created.bookId,
    )
    expect(imageRequest.input.prompt).toBe(
      `Reference image @${artifact.value.artifactId}: moonlit hero portrait. Preserve subject, composition. Render clean image.`,
    )
    expect(videoRequest.input.prompt).toBe(
      `Subject image @${artifact.value.artifactId}: moonlit hero portrait. Animate subject. Preserve identity, composition. Render coherent video.`,
    )

    resultJson(await invoke('move_notebook_cells', {
      notebook_id: notebookId,
      slots: [{ id: source.id, row: 4, column: 0 }],
    }))
    const moved = resultJson(await invoke('get_notebook', {
      notebook_id: notebookId,
    })) as { cells: Array<{ id: string; prompt?: string }> }
    expect(moved.cells.find((cell) => cell.id === image.id)?.prompt)
      .toBe(connected.cells.find((cell) => cell.id === image.id)?.prompt)
    expect(moved.cells.find((cell) => cell.id === video.id)?.prompt)
      .toBe(connected.cells.find((cell) => cell.id === video.id)?.prompt)

    const explicitPrompt = 'Keep exact silhouette. No extra text.'
    resultJson(await invoke('update_notebook_cell', {
      notebook_id: notebookId,
      cell_id: image.id,
      cell: { prompt: explicitPrompt },
    }))
    const imageEdge = connected.edges.find((edge) => edge.target === image.id)
    expect(imageEdge).toBeDefined()
    resultJson(await invoke('disconnect_notebook_cells', {
      notebook_id: notebookId,
      edge_id: imageEdge!.id,
    }))
    const edited = resultJson(await invoke('get_notebook', {
      notebook_id: notebookId,
    })) as {
      cells: Array<{
        id: string
        inputs?: Record<string, unknown>
        prompt?: string
      }>
    }
    const editedImage = edited.cells.find((cell) => cell.id === image.id)
    expect(editedImage?.prompt).toBe(explicitPrompt)
    expect(editedImage?.inputs?.initialGenerationPrompt).toBeUndefined()
  })

  it('infers Gemini Omni reference mode for a connected default video cell', async () => {
    const definitions = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(definitions.map((definition) => [
      definition.name,
      definition,
    ]))
    const created = resultJson(await byName.get('create_book')!.handler({
      name: 'omni-reference-mode',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return

    const invoke = async (name: string, args: Record<string, unknown>) => {
      const definition = byName.get(name)
      if (!definition) throw new Error(`Missing ${name}`)
      return await withBookContext(
        { bookId: created.bookId, engine: managed.value.engine },
        () => definition.handler({ book_id: created.bookId, ...args }),
      )
    }

    const notebooks = resultJson(await invoke('list_notebooks', {})) as Array<{
      id: string
    }>
    const notebookId = notebooks[0]!.id
    const artifact = await managed.value.engine.artifacts.create(
      'image',
      'Reference portrait',
    )
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return

    const source = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'image',
        slot: { row: 0, column: 0 },
        output_artifact_id: artifact.value.artifactId,
      },
    })) as { id: string }
    const target = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_video',
        slot: { row: 1, column: 0 },
        prompt: 'Animate the reference portrait',
      },
    })) as {
      id: string
      inputs?: Record<string, unknown>
      tool?: string
    }
    expect(target.tool).toBe('generate_kie_seedance_2_5_video')
    expect(target.inputs?.generationMode).toBeUndefined()

    resultJson(await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: source.id,
      target_cell_id: target.id,
      target_input: 'image',
    }))
    const document = managed.value.engine.notebooks.read(notebookId)
    expect(document.ok).toBe(true)
    if (!document.ok) return
    const connectedTarget = document.value.cells.find((cell) =>
      cell.id === target.id)
    if (!connectedTarget) throw new Error('Connected Gemini Omni cell is missing')
    expect(connectedTarget.inputs?.generationMode).toBeUndefined()

    const prepared = await prepareNotebookGeneration(
      managed.value.engine,
      document.value,
      connectedTarget,
      created.bookId,
    )
    expect(prepared.tool).toBe('generate_kie_seedance_2_5_video')
    expect(prepared.input.image_refs).toEqual([
      `@${artifact.value.artifactId}`,
    ])
    expect(prepared.input.duration).toBe('13')
  })
})
