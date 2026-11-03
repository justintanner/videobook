import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookDocument } from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import { cellInputParams, pruneInputParams } from '../../server/src/generation-input-params.js'
import { mediaGenerationArgs, notebookCellDefinitionFingerprint } from '../../server/src/jobs/run-notebook.js'
import { resolveModel } from '../../server/src/media/descriptor.js'
import { previewGeneration } from '../../server/src/media/preview.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'

const TARGET = '01900000-0000-7000-8000-00000000a100'

function source(index: number, type: 'image' | 'video'): NotebookCell {
  return {
    id: `01900000-0000-7000-8000-00000000b10${index}`,
    type,
    slot: { row: 0, column: index },
    prompt: `${type} cue ${index}`,
    outputArtifactId: `art-${type}-${index}`,
  }
}

function documentFor(model: string, ports: Array<[string, 'image' | 'video']>, inputs: Record<string, unknown>): NotebookDocument {
  const resolved = resolveModel(model)
  const sources = ports.map(([, type], index) => source(index, type))
  return {
    id: '01900000-0000-7000-8000-00000000c100',
    name: 'params',
    createdAt: '2026-01-01T00:00:00.000Z',
    cells: [{
      id: TARGET,
      type: `generate_${resolved.media}`,
      slot: { row: 1, column: 0 },
      prompt: 'Animate the scene',
      provider: resolved.provider,
      model: resolved.id,
      operation: resolved.entry.operations[0] ?? '',
      tool: `generate_${resolved.media}`,
      inputs,
    }, ...sources],
    edges: ports.map(([targetInput], index) => ({
      id: `01900000-0000-7000-8000-00000000d10${index}`,
      source: sources[index]!.id,
      target: TARGET,
      targetInput,
    })),
  }
}

function payloadFor(model: string, ports: Array<[string, 'image' | 'video']>, inputs: Record<string, unknown>) {
  const document = documentFor(model, ports, inputs)
  const cell = document.cells[0]!
  const { input } = mediaGenerationArgs(resolveModel(model), document, cell, 'book')
  const preview = previewGeneration(input)
  if (!preview.ok) throw new Error(preview.error)
  return { input, payload: preview.preview.payload }
}

const GROK = 'kie:grok-imagine-video-1-5-preview'
const GROK_PORTS: Array<[string, 'image']> = [['image', 'image'], ['keyframe', 'image'], ['keyframe_2', 'image']]

describe('per-item input params', () => {
  it('builds the same Grok payload from legacy keyframe seconds, stored params and ref_params', () => {
    const legacy = payloadFor(GROK, GROK_PORTS, { generationMode: 'i2v', generationSettings: { keyframe_1_seconds: 2, keyframe_2_seconds: 5 } })
    const stored = payloadFor(GROK, GROK_PORTS, { generationMode: 'i2v', inputParams: { keyframe: { timestamp_s: 2 }, keyframe_2: { timestamp_s: 5 } } })
    expect(stored.input.ref_params).toEqual({ keyframe: [{ timestamp_s: 2 }, { timestamp_s: 5 }] })
    expect(stored.payload).toEqual(legacy.payload)
    expect((legacy.payload as { input: { keyframes: unknown } }).input.keyframes).toEqual([
      { url: 'http://url.resolved.later.for/art-image-1', timestamp_s: 2 },
      { url: 'http://url.resolved.later.for/art-image-2', timestamp_s: 5 },
    ])
    const direct = previewGeneration({
      model: GROK,
      prompt: legacy.input.prompt,
      mode: 'i2v',
      refs: legacy.input.refs,
      ref_params: { keyframe: [{ timestamp_s: 2 }, { timestamp_s: 5 }] },
    })
    expect(direct.ok && direct.preview.payload).toEqual(legacy.payload)
  })

  it('lets a stored param win over the legacy setting at the same position and ignores unknown names', () => {
    const mixed = payloadFor(GROK, GROK_PORTS, {
      generationMode: 'i2v',
      generationSettings: { keyframe_1_seconds: 2, keyframe_2_seconds: 5 },
      inputParams: { keyframe_2: { timestamp_s: 7, bogus: 1 }, image: { timestamp_s: 3 } },
    })
    expect(mixed.input.ref_params).toEqual({ keyframe: [null, { timestamp_s: 7 }] })
    expect((mixed.payload as { input: { keyframes: Array<{ timestamp_s: number }> } }).input.keyframes.map((frame) => frame.timestamp_s)).toEqual([2, 7])
  })

  it('maps Gemini Omni clip times through the same params as its clip_start and clip_end settings', () => {
    const ports: Array<[string, 'image' | 'video']> = [['video', 'video']]
    const legacy = payloadFor('kie:gemini-omni-video', ports, { generationMode: 'v2v', generationSettings: { clip_start: 1, clip_end: 6 } })
    const stored = payloadFor('kie:gemini-omni-video', ports, { generationMode: 'v2v', inputParams: { video: { start: 1, ends: 6 } } })
    expect(stored.payload).toEqual(legacy.payload)
  })

  it('keeps explicit FLUX keyframe frame indexes and spaces the rest', () => {
    const ports: Array<[string, 'image']> = [['image', 'image'], ['image_2', 'image'], ['image_3', 'image']]
    const spaced = payloadFor('fal:blackforestlabs/flux-3/keyframes-to-video', ports, {})
    const pinned = payloadFor('fal:blackforestlabs/flux-3/keyframes-to-video', ports, { inputParams: { image_2: { frame_index: 30 } } })
    const frames = (payload: unknown) => ((payload as { input: { keyframes: Array<{ frame_index: number }> } }).input.keyframes).map((frame) => frame.frame_index)
    const even = frames(spaced.payload)
    expect(frames(pinned.payload)).toEqual([even[0], 30, even[2]])
  })

  it('changes the definition fingerprint only when a param is stored', () => {
    const plain = documentFor(GROK, GROK_PORTS, { generationMode: 'i2v' })
    const withParams = documentFor(GROK, GROK_PORTS, { generationMode: 'i2v', inputParams: { keyframe: { timestamp_s: 2 } } })
    const emptied = documentFor(GROK, GROK_PORTS, { generationMode: 'i2v' })
    expect(notebookCellDefinitionFingerprint(withParams, withParams.cells[0]!)).not.toBe(notebookCellDefinitionFingerprint(plain, plain.cells[0]!))
    expect(notebookCellDefinitionFingerprint(emptied, emptied.cells[0]!)).toBe(notebookCellDefinitionFingerprint(plain, plain.cells[0]!))
  })

  it('prunes params whose port has no edge and drops an emptied map', () => {
    const document = documentFor(GROK, GROK_PORTS, { generationMode: 'i2v', inputParams: { keyframe: { timestamp_s: 2 }, keyframe_3: { timestamp_s: 9 } } })
    const pruned = pruneInputParams(document)
    expect(cellInputParams(pruned.cells[0]!)).toEqual({ keyframe: { timestamp_s: 2 } })
    const disconnected = pruneInputParams({ ...document, edges: document.edges.filter((edge) => edge.targetInput === 'image') })
    expect(disconnected.cells[0]!.inputs).toEqual({ generationMode: 'i2v' })
    expect(pruneInputParams(disconnected)).toBe(disconnected)
  })
})

function resultJson(result: Awaited<ReturnType<ToolDef['handler']>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined()
  return JSON.parse(result.content[0]!.text) as unknown
}

describe('per-item input param storage', () => {
  let rootDir: string
  let books: BookManager

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-input-params-'))
    books = new BookManager({ libraryDir: join(rootDir, 'books'), objectPrefix: 'test-objects' })
    await books.ready()
  })

  afterEach(async () => {
    await books.close()
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('strips params on create, keeps stored params on update and prunes them on disconnect', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({ name: 'input-param-storage' })) as { bookId: string }
    const managed = books.get(created.bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    const { engine } = managed.value
    const notebookId = engine.notebooks.list()[0]!.id
    const invoke = async (name: string, args: Record<string, unknown>) => resultJson(await withBookContext(
      { bookId: created.bookId, engine },
      () => byName.get(name)!.handler({ book_id: created.bookId, notebook_id: notebookId, ...args }),
    ))
    const artifact = await engine.artifacts.create('image', 'still')
    if (!artifact.ok) throw new Error(artifact.error.message)
    const image = await invoke('create_notebook_cell', { cell: { type: 'image', slot: { row: 0, column: 0 }, output_artifact_id: artifact.value.artifactId } }) as { id: string }
    const generation = await invoke('create_notebook_cell', {
      cell: {
        type: 'generate_video',
        slot: { row: 1, column: 0 },
        provider: 'kie',
        model: GROK,
        operation: 'image_to_video',
        tool: 'generate_video',
        inputs: { generationMode: 'i2v', inputParams: { keyframe: { timestamp_s: 3 } } },
      },
    }) as { id: string; inputs?: Record<string, unknown> }
    expect(generation.inputs?.inputParams).toBeUndefined()

    const edge = await invoke('connect_notebook_cells', { source_cell_id: image.id, target_cell_id: generation.id, target_input: 'keyframe' }) as { id: string }
    const read = () => {
      const current = engine.notebooks.read(notebookId)
      if (!current.ok) throw new Error(current.error.message)
      return current.value.cells.find((cell) => cell.id === generation.id)!
    }
    const current = engine.notebooks.read(notebookId)
    if (!current.ok) throw new Error(current.error.message)
    await engine.notebooks.write({
      ...current.value,
      cells: current.value.cells.map((cell) => cell.id === generation.id
        ? { ...cell, inputs: { ...cell.inputs, inputParams: { keyframe: { timestamp_s: 3 } } } }
        : cell),
    })

    await invoke('update_notebook_cell', {
      cell_id: generation.id,
      cell: { inputs: { generationMode: 'i2v', generationSettings: { duration: 6 }, inputParams: { keyframe: { timestamp_s: 99 } } } },
    })
    expect(cellInputParams(read())).toEqual({ keyframe: { timestamp_s: 3 } })
    expect(read().inputs?.generationSettings).toEqual({ duration: 6 })

    await invoke('disconnect_notebook_cells', { edge_id: edge.id })
    expect(read().inputs?.inputParams).toBeUndefined()
  })
})
