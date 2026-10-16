import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Engine, NotebookCell, NotebookDocument, Result } from 'videobook-engine'
import { BookManager } from '../../server/src/book-manager'
import { withBookContext } from '../../server/src/book-context'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain'
import type { ToolDef } from '../../server/src/tools/tool-def'
import { notebookConnectionWouldCreateCycle } from '../../server/src/notebook-graph'

function valueOf<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function json(result: Awaited<ReturnType<ToolDef['handler']>>) {
  expect(result.isError, result.content[0]?.text).toBeUndefined()
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

describe('reusing descendant images as generation inputs', () => {
  let rootDir: string
  let books: BookManager
  let engine: Engine
  let bookId: string
  let notebookId: string
  let generator: NotebookCell
  let video: NotebookCell
  let frames: NotebookCell[]
  let original: NotebookDocument
  let png: Buffer
  let defs: Map<string, ToolDef>

  const read = () => valueOf(engine.notebooks.read(notebookId))
  const invoke = (name: string, args: Record<string, unknown>) => withBookContext(
    { bookId, engine },
    () => defs.get(name)!.handler({ book_id: bookId, notebook_id: notebookId, ...args }),
  )

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-descendant-images-'))
    books = new BookManager({ libraryDir: join(rootDir, 'books'), objectPrefix: 'test-objects' })
    await books.ready()
    bookId = valueOf(await books.create('descendant-images')).bookId
    engine = valueOf(books.get(bookId)).engine
    notebookId = engine.notebooks.list()[0]!.id
    defs = new Map(videobookDomainDefs(engine, books).map((def) => [def.name, def]))
    png = await sharp({ create: { width: 16, height: 12, channels: 3, background: 'green' } }).png().toBuffer()
    generator = engine.notebooks.createCell({
      type: 'generate_video',
      slot: { row: 2, column: 7 },
      prompt: 'Animate @image1 and @image2',
      provider: 'kie',
      model: 'kie:bytedance/seedance-2-5',
      operation: 'text_to_video',
      tool: 'generate_video',
      inputs: { generationMode: 'r2v', generationSettings: { aspect_ratio: '9:16', duration: 20 } },
    })
    const videoArtifact = valueOf(await engine.artifacts.create('video', 'Previous output'))
    video = engine.notebooks.createCell({
      type: 'video',
      slot: { row: 3, column: 7 },
      outputArtifactId: videoArtifact.artifactId,
      inputs: { mediaRole: 'generate-video-output', producerCellId: generator.id, state: 'completed' },
    })
    frames = []
    for (const [index, seconds] of [2.671, 0, 4].entries()) {
      const artifact = valueOf(await engine.artifacts.create('image', `Frame ${seconds}`))
      valueOf(await engine.files.write(artifact.artifactId, 'original.png', png))
      frames.push(engine.notebooks.createCell({
        type: 'image',
        slot: { row: 0, column: 3 + index },
        outputArtifactId: artifact.artifactId,
        inputs: { mediaRole: 'extract-frame-output', sourceCellId: video.id, frameMode: 'time', atSeconds: seconds, state: 'completed' },
      }))
    }
    original = {
      ...read(),
      cells: [generator, video, ...frames],
      edges: [
        engine.notebooks.createEdge({ source: generator.id, target: video.id, targetInput: 'media' }),
        ...frames.map((frame) => engine.notebooks.createEdge({ source: video.id, target: frame.id, targetInput: 'segment' })),
      ],
    }
    valueOf(await engine.notebooks.write(original))
    original = read()
    generator = original.cells.find((cell) => cell.id === generator.id)!
    video = original.cells.find((cell) => cell.id === video.id)!
    frames = frames.map((frame) => original.cells.find((cell) => cell.id === frame.id)!)
  })

  afterEach(async () => {
    await books.close()
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  it.each(['connect_notebook_cells', 'set_notebook_cell_input'])('reuses extracted frames through %s and preserves their bytes and unrelated lineage', async (name) => {
    const before = engine.head
    for (const [index, frame] of frames.slice(0, 2).entries()) {
      json(await invoke(name, {
        source_cell_id: frame.id,
        target_cell_id: generator.id,
        target_input: index === 0 ? 'image' : 'image_2',
        expected_revision: engine.head,
      }))
      const current = read()
      expect(current.edges.some((edge) => edge.source === video.id && edge.target === frame.id)).toBe(false)
      expect(current.cells.find((cell) => cell.id === frame.id)).toEqual(frame)
      expect(valueOf(await engine.files.read(frame.outputArtifactId!, 'original.png'))).toEqual(png)
      for (const edge of current.edges) {
        expect(notebookConnectionWouldCreateCycle(
          current.edges.filter((candidate) => candidate.id !== edge.id), edge.source, edge.target,
        )).toBe(false)
      }
    }
    const updated = read()
    expect(updated.cells).toHaveLength(original.cells.length)
    expect(updated.edges.filter((edge) => edge.source === video.id)).toEqual([
      original.edges.find((edge) => edge.target === frames[2]!.id),
    ])
    expect(updated.edges.find((edge) => edge.target === video.id)).toEqual(original.edges[0])
    expect(updated.cells.find((cell) => cell.id === video.id)).toEqual(video)
    const preview = json(await invoke('preview_notebook_generation', { cell_id: generator.id }))
    expect(preview.mentions).toMatchObject({ prompt_leaks: [] })
    expect(preview.payload).toMatchObject({
      input: {
        prompt: 'Animate @Image1 and @Image2',
        reference_image_urls: frames.slice(0, 2).map((frame) => `http://url.resolved.later.for/${frame.outputArtifactId}`),
      },
    })
    const after = engine.head
    valueOf(await engine.history.restore(before))
    expect(read().edges).toEqual(original.edges)
    valueOf(await engine.history.restore(after))
    expect(read().edges).toEqual(updated.edges)
    await books.close()
    books = new BookManager({ libraryDir: join(rootDir, 'books'), objectPrefix: 'test-objects' })
    await books.ready()
    engine = valueOf(books.get(bookId)).engine
    expect(read().edges).toEqual(updated.edges)
    for (const frame of frames) {
      expect(valueOf(await engine.files.read(frame.outputArtifactId!, 'original.png'))).toEqual(png)
    }
  })

  it('previews descendant image prompt references without changing the saved graph', async () => {
    const before = engine.head
    const preview = json(await invoke('preview_notebook_generation', {
      cell_id: generator.id,
      connections: frames.slice(0, 2).map((frame, index) => ({
        source_cell_id: frame.id,
        target_input: index === 0 ? 'image' : 'image_2',
      })),
    }))
    expect(preview.mentions).toMatchObject({ prompt_leaks: [] })
    expect(preview.payload).toMatchObject({ input: { prompt: 'Animate @Image1 and @Image2' } })
    expect(engine.head).toBe(before)
    expect(read()).toEqual(original)
  })

  it.each(['connect_notebook_cells', 'set_notebook_cell_input'])('keeps the graph intact when %s rejects a stale revision or invalid input', async (name) => {
    for (const extra of [
      { expected_revision: 'stale-revision' },
      { target_cell_id: video.id, target_input: 'media' },
      { source_cell_id: video.id },
      { source_cell_id: generator.id },
    ]) {
      const before = engine.head
      const result = await invoke(name, {
        source_cell_id: frames[0]!.id,
        target_cell_id: generator.id,
        target_input: 'image',
        ...extra,
      })
      expect(result.isError).toBe(true)
      expect(engine.head).toBe(before)
      expect(read()).toEqual(original)
    }
  })

  it.each(['video', 'unresolved'] as const)('preserves lineage when the descendant image is %s', async (invalid) => {
    const frame = frames[0]!
    valueOf(await engine.notebooks.write({
      ...read(),
      cells: read().cells.map((cell) => cell.id === frame.id ? {
        ...cell,
        outputArtifactId: invalid === 'video' ? video.outputArtifactId : undefined,
      } : cell),
    }))
    const before = read()
    const revision = engine.head
    const result = await invoke('set_notebook_cell_input', {
      source_cell_id: frame.id,
      target_cell_id: generator.id,
      target_input: 'image',
    })
    expect(result.isError).toBe(true)
    expect(read()).toEqual(before)
    expect(engine.head).toBe(revision)
  })
})
