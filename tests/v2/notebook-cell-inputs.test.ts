import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Engine, NotebookCell, NotebookDocument } from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import { resolvedInitialGenerationPrompt } from '../../server/src/notebook-initial-generation-prompt.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'

const GROK = 'kie:grok-imagine-video-1-5-preview'

type Result = Awaited<ReturnType<ToolDef['handler']>>
type InputsResult = { changed: boolean; revision: string; inputs: Array<{ edge_id: string; source_cell_id: string; target_input: string }>; input_params: Record<string, Record<string, number>>; prompt: string }

describe('set_notebook_cell_inputs', () => {
  let rootDir: string
  let books: BookManager
  let engine: Engine
  let notebookId: string
  let bookId: string
  let byName: Map<string, ToolDef>
  let cells: Record<'a' | 'b' | 'c' | 'audio' | 'prompt' | 'generation', NotebookCell>

  const raw = async (name: string, args: Record<string, unknown>): Promise<Result> => withBookContext(
    { bookId, engine },
    () => byName.get(name)!.handler({ book_id: bookId, notebook_id: notebookId, ...args }),
  )
  const invoke = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await raw(name, args)
    expect(result.isError, result.content[0]?.text).toBeUndefined()
    return JSON.parse(result.content[0]!.text) as T
  }
  const setInputs = (inputs: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
    invoke<InputsResult>('set_notebook_cell_inputs', { cell_id: cells.generation.id, inputs, ...extra })
  const notebook = (): NotebookDocument => {
    const read = engine.notebooks.read(notebookId)
    if (!read.ok) throw new Error(read.error.message)
    return read.value
  }
  const generation = () => notebook().cells.find((cell) => cell.id === cells.generation.id)!
  const ports = () => notebook().edges
    .filter((edge) => edge.target === cells.generation.id)
    .map((edge) => [edge.source, edge.targetInput])
    .sort()

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-cell-inputs-'))
    books = new BookManager({ libraryDir: join(rootDir, 'books'), objectPrefix: 'test-objects' })
    await books.ready()
    byName = new Map(videobookDomainDefs(scopedBookEngine, books).map((def) => [def.name, def]))
    const created = await byName.get('create_book')!.handler({ name: 'cell-inputs' })
    bookId = (JSON.parse(created.content[0]!.text) as { bookId: string }).bookId
    const managed = books.get(bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    engine = managed.value.engine
    notebookId = engine.notebooks.list()[0]!.id
    const media = async (kind: 'image' | 'audio', label: string, column: number) => {
      const artifact = await engine.artifacts.create(kind, label)
      if (!artifact.ok) throw new Error(artifact.error.message)
      return invoke<NotebookCell>('create_notebook_cell', { cell: { type: kind, label, slot: { row: 0, column }, output_artifact_id: artifact.value.artifactId } })
    }
    cells = {
      a: await media('image', 'subject', 0),
      b: await media('image', 'pose one', 1),
      c: await media('image', 'pose two', 2),
      audio: await media('audio', 'voice', 3),
      prompt: await invoke<NotebookCell>('create_notebook_cell', { cell: { type: 'prompt', slot: { row: 0, column: 4 }, prompt: 'A cue' } }),
      generation: await invoke<NotebookCell>('create_notebook_cell', {
        cell: { type: 'generate_video', slot: { row: 1, column: 0 }, provider: 'kie', model: GROK, operation: 'image_to_video', tool: 'generate_video', inputs: { generationMode: 'i2v' } },
      }),
    }
    await invoke('connect_notebook_cells', { source_cell_id: cells.prompt.id, target_cell_id: cells.generation.id, target_input: 'prompt' })
  })

  afterEach(async () => {
    await books.close()
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  const layout = () => [
    { source_cell_id: cells.a.id, target_input: 'image' },
    { source_cell_id: cells.b.id, target_input: 'keyframe' },
    { source_cell_id: cells.c.id, target_input: 'keyframe_2', params: { timestamp_s: 5 } },
    { source_cell_id: cells.audio.id, target_input: 'replace_audio' },
  ]

  it('writes the whole layout once, keeps the prompt edge, marks the cell and its dependents stale and does nothing on a repeat', async () => {
    const downstream = await invoke<NotebookCell>('create_notebook_cell', { cell: { type: 'generate_video', slot: { row: 2, column: 0 }, provider: 'kie', model: GROK, operation: 'image_to_video', tool: 'generate_video' } })
    await invoke('connect_notebook_cells', { source_cell_id: cells.generation.id, target_cell_id: downstream.id, target_input: 'video' })
    const written = await engine.notebooks.write({
      ...notebook(),
      execution: { [cells.generation.id]: { status: 'ready', tool: 'generate_video' }, [downstream.id]: { status: 'ready', tool: 'generate_video' } },
    })
    if (!written.ok) throw new Error(written.error.message)
    expect(notebook().execution?.[downstream.id]?.stale).not.toBe(true)

    const first = await setInputs(layout())
    expect(first.changed).toBe(true)
    expect(first.input_params).toEqual({ keyframe_2: { timestamp_s: 5 } })
    expect(ports()).toEqual([
      [cells.a.id, 'image'], [cells.b.id, 'keyframe'], [cells.c.id, 'keyframe_2'], [cells.audio.id, 'replace_audio'], [cells.prompt.id, 'prompt'],
    ].sort())
    expect(generation().inputs?.inputParams).toEqual({ keyframe_2: { timestamp_s: 5 } })
    expect(notebook().execution?.[cells.generation.id]?.stale).toBe(true)
    expect(notebook().execution?.[downstream.id]?.stale).toBe(true)

    const head = engine.head
    const repeat = await setInputs(layout())
    expect(repeat.changed).toBe(false)
    expect(engine.head).toBe(head)
    expect(repeat.inputs.map((input) => input.edge_id)).toEqual(first.inputs.map((input) => input.edge_id))
  })

  it('treats the same layout listed in another order as unchanged', async () => {
    const items = [
      { source_cell_id: cells.b.id, target_input: 'keyframe', params: { timestamp_s: 2 } },
      { source_cell_id: cells.c.id, target_input: 'keyframe_2', params: { timestamp_s: 5 } },
      { source_cell_id: cells.a.id, target_input: 'image' },
    ]
    const first = await setInputs([...items].reverse())
    expect(Object.keys(first.input_params)).toEqual(['keyframe', 'keyframe_2'])
    const head = engine.head
    expect((await setInputs(items)).changed).toBe(false)
    expect(engine.head).toBe(head)
  })

  it('swaps two keyframes with fresh edge ids, keeps unchanged ids and lets explicit params replace carried ones', async () => {
    const first = await setInputs(layout())
    const ids = new Map(first.inputs.map((input) => [input.source_cell_id, input.edge_id]))
    const swapped = await setInputs([
      { source_cell_id: cells.a.id, target_input: 'image' },
      { source_cell_id: cells.c.id, target_input: 'keyframe' },
      { source_cell_id: cells.b.id, target_input: 'keyframe_2', params: { timestamp_s: 8 } },
      { source_cell_id: cells.audio.id, target_input: 'replace_audio' },
    ])
    const after = new Map(swapped.inputs.map((input) => [input.source_cell_id, input.edge_id]))
    expect(after.get(cells.a.id)).toBe(ids.get(cells.a.id))
    expect(after.get(cells.audio.id)).toBe(ids.get(cells.audio.id))
    expect(after.get(cells.b.id)).not.toBe(ids.get(cells.b.id))
    expect(after.get(cells.c.id)).not.toBe(ids.get(cells.c.id))
    expect(swapped.input_params).toEqual({ keyframe: { timestamp_s: 5 }, keyframe_2: { timestamp_s: 8 } })
    const edges = notebook().edges.map((edge) => edge.id)
    expect(edges).toEqual([...edges].sort())
  })

  it('rotates three inputs through each other, carries params with their sources and reseeds the initial prompt', async () => {
    const first = await setInputs([
      { source_cell_id: cells.a.id, target_input: 'image' },
      { source_cell_id: cells.b.id, target_input: 'keyframe', params: { timestamp_s: 3 } },
      { source_cell_id: cells.c.id, target_input: 'keyframe_2', params: { timestamp_s: 5 } },
    ])
    expect(first.prompt).toBe(resolvedInitialGenerationPrompt(notebook(), generation()))
    const rotated = await setInputs([
      { source_cell_id: cells.a.id, target_input: 'keyframe' },
      { source_cell_id: cells.b.id, target_input: 'keyframe_2' },
      { source_cell_id: cells.c.id, target_input: 'image', params: {} },
    ])
    expect(rotated.inputs.map((input) => input.edge_id).filter((id) => first.inputs.some((input) => input.edge_id === id))).toEqual([])
    expect(ports()).toEqual([[cells.a.id, 'keyframe'], [cells.b.id, 'keyframe_2'], [cells.c.id, 'image'], [cells.prompt.id, 'prompt']].sort())
    expect(rotated.input_params).toEqual({ keyframe_2: { timestamp_s: 3 } })
    expect(rotated.prompt).toBe(resolvedInitialGenerationPrompt(notebook(), generation()))
    expect(generation().prompt).toBe(rotated.prompt)
    expect(generation().inputs?.initialGenerationPrompt).toEqual({ prompt: rotated.prompt, version: 1 })
    for (const [source, token] of [[cells.a, '@keyframe1'], [cells.b, '@keyframe2'], [cells.c, '@image1']] as const) {
      expect(rotated.prompt).toContain(`${source.id === cells.c.id ? 'Subject image' : 'Keyframe'} ${token}`)
    }
    expect(rotated.prompt).not.toMatch(/Subject image @keyframe|Keyframe @image/)
  })

  it('remaps a written prompt so every token follows its input in any mode', async () => {
    await setInputs(layout())
    await invoke('update_notebook_cell', { cell_id: cells.generation.id, cell: { prompt: 'Hold @image1, hit @keyframe1, land @keyframe2' } })
    const moved = await setInputs([
      { source_cell_id: cells.a.id, target_input: 'first_frame' },
      { source_cell_id: cells.c.id, target_input: 'keyframe' },
      { source_cell_id: cells.b.id, target_input: 'image' },
    ])
    expect(moved.prompt).toBe('Hold @firstframe, hit @image1, land @keyframe1')
  })

  it('folds legacy keyframe seconds into params without changing the payload', async () => {
    for (const [source, port] of [[cells.a.id, 'image'], [cells.b.id, 'keyframe'], [cells.c.id, 'keyframe_2']] as const) {
      await invoke('connect_notebook_cells', { source_cell_id: source, target_cell_id: cells.generation.id, target_input: port })
    }
    await invoke('update_notebook_cell', { cell_id: cells.generation.id, cell: { inputs: { generationMode: 'i2v', generationSettings: { duration: 10, keyframe_1_seconds: 2, keyframe_2_seconds: 6 } } } })
    const before = await invoke<{ payload: unknown }>('preview_notebook_generation', { cell_id: cells.generation.id })
    const converted = await setInputs([
      { source_cell_id: cells.a.id, target_input: 'image' },
      { source_cell_id: cells.b.id, target_input: 'keyframe' },
      { source_cell_id: cells.c.id, target_input: 'keyframe_2' },
    ])
    expect(converted.changed).toBe(true)
    expect(converted.input_params).toEqual({ keyframe: { timestamp_s: 2 }, keyframe_2: { timestamp_s: 6 } })
    expect(generation().inputs?.generationSettings).toEqual({ duration: 10 })
    const after = await invoke<{ payload: unknown }>('preview_notebook_generation', { cell_id: cells.generation.id })
    expect(after.payload).toEqual(before.payload)
  })

  it('keeps a legacy time for a keyframe whose source has not run and clears a time with no keyframe', async () => {
    const pending = await invoke<NotebookCell>('create_notebook_cell', { cell: { type: 'generate_image', slot: { row: 0, column: 5 }, prompt: 'A pose' } })
    for (const [source, port] of [[cells.a.id, 'image'], [cells.b.id, 'keyframe'], [pending.id, 'keyframe_2']] as const) {
      await invoke('connect_notebook_cells', { source_cell_id: source, target_cell_id: cells.generation.id, target_input: port })
    }
    await invoke('update_notebook_cell', { cell_id: cells.generation.id, cell: { inputs: { generationMode: 'i2v', generationSettings: { duration: 10, keyframe_1_seconds: 2, keyframe_2_seconds: 6, keyframe_3_seconds: 9 } } } })
    const converted = await setInputs([
      { source_cell_id: cells.a.id, target_input: 'image' },
      { source_cell_id: cells.b.id, target_input: 'keyframe' },
      { source_cell_id: pending.id, target_input: 'keyframe_2' },
    ])
    expect(converted.input_params).toEqual({ keyframe: { timestamp_s: 2 }, keyframe_2: { timestamp_s: 6 } })
    expect(generation().inputs?.generationSettings).toEqual({ duration: 10 })
  })

  it('refuses invalid layouts and cycles without writing', async () => {
    await setInputs(layout())
    const downstream = await invoke<NotebookCell>('create_notebook_cell', { cell: { type: 'generate_video', slot: { row: 2, column: 0 }, provider: 'kie', model: GROK, operation: 'image_to_video', tool: 'generate_video' } })
    await invoke('connect_notebook_cells', { source_cell_id: cells.generation.id, target_cell_id: downstream.id, target_input: 'video' })
    const head = engine.head
    const refusals: Array<[Array<Record<string, unknown>>, string]> = [
      [[{ source_cell_id: cells.a.id, target_input: 'image' }, { source_cell_id: cells.b.id, target_input: 'image' }], 'Two inputs use image'],
      [[{ source_cell_id: cells.prompt.id, target_input: 'image' }], 'does not produce media'],
      [[{ source_cell_id: cells.audio.id, target_input: 'keyframe_2' }], 'produces audio but keyframe_2 takes image'],
      [[{ source_cell_id: cells.a.id, target_input: 'replace_audio' }], 'produces image but replace_audio takes audio'],
      [[{ source_cell_id: cells.a.id, target_input: 'prompt' }], 'prompt is already connected to @a5'],
      [[{ source_cell_id: cells.generation.id, target_input: 'image' }], 'cannot be its own input'],
      [[{ source_cell_id: downstream.id, target_input: 'video' }], 'cycle'],
    ]
    for (const [inputs, message] of refusals) {
      const result = await raw('set_notebook_cell_inputs', { cell_id: cells.generation.id, inputs })
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain(message)
    }
    const image = await raw('set_notebook_cell_inputs', { cell_id: cells.a.id, inputs: [] })
    expect(image.content[0]!.text).toContain('is not a generation cell')
    expect(engine.head).toBe(head)
  })

  it('lets only one of two writes at the same revision land', async () => {
    const expected_revision = engine.head
    const results = await Promise.all([
      raw('set_notebook_cell_inputs', { cell_id: cells.generation.id, inputs: [{ source_cell_id: cells.a.id, target_input: 'image' }], expected_revision }),
      raw('set_notebook_cell_inputs', { cell_id: cells.generation.id, inputs: [{ source_cell_id: cells.b.id, target_input: 'image' }], expected_revision }),
    ])
    expect(results.filter((result) => !result.isError)).toHaveLength(1)
    expect(results.filter((result) => result.isError)).toHaveLength(1)
  })
})
