import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { NotebookDocument } from 'videobook-engine'
import { afterEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import { FFMPEG } from '../../server/src/ffmpeg.js'
import { registerRunNotebookJob } from '../../server/src/jobs/run-notebook.js'
import {
  queue,
  setEngineRoot,
  stopBookQueue,
} from '../../server/src/queue.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'
import {
  enqueueNotebookFrameCommand,
  parseNotebookFrameCommand,
  resolveNotebookFrameSource,
} from '../../src/videobook/notebook-frame-command'

const execFileAsync = promisify(execFile)

function resultJson(result: Awaited<ReturnType<ToolDef['handler']>>): unknown {
  if (result.isError) throw new Error(result.content[0]?.text ?? 'Tool failed')
  return JSON.parse(result.content[0]!.text) as unknown
}

async function waitForJob(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await queue.getStatus(jobId)
    if (status?.state === 'completed') return
    if (status?.state === 'failed') {
      throw new Error(status.error?.message ?? 'Frame extraction failed')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Frame extraction did not complete')
}

describe('notebook frame commands', () => {
  let rootDir: string | undefined
  let books: BookManager | undefined
  let bookId: string | undefined

  afterEach(async () => {
    if (bookId) await stopBookQueue(bookId)
    if (books) await books.close()
    if (rootDir) {
      await rm(rootDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      })
    }
  })

  it('parses direct first and last frame requests without claiming other prompts', () => {
    expect(parseNotebookFrameCommand(
      'extract the first frame of @vid-01',
    )).toEqual({
      frameMode: 'first',
      sourceReference: 'vid-01',
    })
    expect(parseNotebookFrameCommand(
      'Please capture last frame from @VID-ENDING.',
    )).toEqual({
      frameMode: 'last',
      sourceReference: 'vid-ending',
    })
    expect(parseNotebookFrameCommand(
      'generate an image inspired by @vid-01',
    )).toBeNull()
  })

  it('creates, runs, and reuses the typed Extract Frame workflow', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-frame-command-'))
    books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    await books.ready()
    const created = await books.create('frame-command')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    bookId = created.value.bookId
    const managed = books.get(bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    await setEngineRoot(rootDir, engine)
    registerRunNotebookJob(engine)

    const defs = new Map(
      videobookDomainDefs(scopedBookEngine, books).map((def) => [def.name, def]),
    )
    const callTool = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      const def = defs.get(name)
      if (!def) throw new Error(`Missing ${name}`)
      return await withBookContext(
        { bookId: bookId!, engine },
        async () => resultJson(await def.handler(args)),
      )
    }

    const notebooks = await callTool('list_notebooks', {
      book_id: bookId,
    }) as Array<{ id: string }>
    const notebookId = notebooks[0]!.id
    const sourcePath = join(rootDir, 'source.mp4')
    await execFileAsync(FFMPEG, [
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=blue:s=64x64:r=24:d=1',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      sourcePath,
    ])
    const artifact = await engine.artifacts.create({
      kind: 'video',
      name: 'source',
    })
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    expect((await engine.files.writeFromPath(
      artifact.value.artifactId,
      'original.mp4',
      sourcePath,
    )).ok).toBe(true)

    const source = await callTool('create_notebook_cell', {
      book_id: bookId,
      notebook_id: notebookId,
      cell: {
        type: 'video',
        slug: 'vid-01',
        slot: { row: 0, column: 0 },
        output_artifact_id: artifact.value.artifactId,
      },
    }) as { id: string }
    await callTool('create_notebook_cell', {
      book_id: bookId,
      notebook_id: notebookId,
      cell: {
        type: 'image',
        slug: 'img-reference',
        slot: { row: 0, column: 1 },
      },
    })
    const beforeResult = engine.notebooks.read(notebookId)
    expect(beforeResult.ok).toBe(true)
    if (!beforeResult.ok) return
    const before: NotebookDocument = beforeResult.value

    expect(resolveNotebookFrameSource(before, 'vid-01').id).toBe(source.id)
    expect(() => resolveNotebookFrameSource(before, 'missing-video'))
      .toThrow('Video cell @missing-video was not found')
    expect(() => resolveNotebookFrameSource(before, 'img-reference'))
      .toThrow('@img-reference is not a video-producing cell')

    const command = parseNotebookFrameCommand(
      'extract the first frame of @vid-01',
    )!
    const firstRun = await enqueueNotebookFrameCommand({
      actor: 'frame-command-test',
      bookId,
      callTool,
      command,
      document: before,
    })
    expect(firstRun).toMatchObject({
      reusedAction: false,
      sourceCellId: source.id,
      sourceSlug: 'vid-01',
    })
    await waitForJob(firstRun.jobId)

    const completedResult = engine.notebooks.read(notebookId)
    expect(completedResult.ok).toBe(true)
    if (!completedResult.ok) return
    const completed: NotebookDocument = completedResult.value
    const action = completed.cells.find((cell) =>
      cell.id === firstRun.actionCellId)
    const output = completed.cells.find((cell) =>
      cell.id === firstRun.outputCellId)
    expect(action).toMatchObject({
      type: 'extract_frame',
      operation: 'extract_frame',
      inputs: { frameMode: 'first' },
    })
    expect(completed.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: source.id,
        target: firstRun.actionCellId,
        targetInput: 'video',
      }),
      expect.objectContaining({
        source: firstRun.actionCellId,
        target: firstRun.outputCellId,
        targetInput: 'media',
      }),
    ]))
    expect(output).toMatchObject({
      type: 'image',
      outputArtifactId: expect.any(String),
      inputs: {
        frameMode: 'first',
        sourceCellId: source.id,
        state: 'completed',
      },
    })
    const manifest = await engine.files.manifest(output!.outputArtifactId!)
    expect(manifest.ok).toBe(true)
    expect(manifest.ok && manifest.value.files.some((file) =>
      file.name === 'original.jpg')).toBe(true)

    const secondRun = await enqueueNotebookFrameCommand({
      actor: 'frame-command-test',
      bookId,
      callTool,
      command,
      document: completed,
    })
    expect(secondRun).toMatchObject({
      actionCellId: firstRun.actionCellId,
      outputCellId: firstRun.outputCellId,
      reusedAction: true,
    })
    await waitForJob(secondRun.jobId)
  }, 30_000)
})
