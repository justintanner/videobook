import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Engine, NotebookDocument } from 'videobook-engine'
import { afterEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import { FFMPEG } from '../../server/src/ffmpeg.js'
import { registerExtractNotebookFrameJob } from '../../server/src/jobs/extract-notebook-frame.js'
import { registerProcessImageJob } from '../../server/src/jobs/process-image.js'
import {
  queue,
  setEngineRoot,
  stopBookQueue,
} from '../../server/src/queue.js'
import { extractNotebookFrameDef } from '../../server/src/tools/extract-notebook-frame.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'
import {
  enqueueNotebookFrameCommand,
  parseNotebookFrameCommand,
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

async function waitForManifestFile(
  engine: Engine,
  artifactId: string,
  filename: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const manifest = await engine.files.manifest(artifactId)
    if (manifest.ok && manifest.value.files.some((file) =>
      file.name === filename)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${filename} never appeared on ${artifactId}`)
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

  async function setup(name: string, clipSeconds: number) {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-frame-command-'))
    books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    await books.ready()
    const created = await books.create(name)
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error(created.error.message)
    bookId = created.value.bookId
    const managed = books.get(bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) throw new Error(managed.error.message)
    const engine = managed.value.engine
    await setEngineRoot(rootDir, engine)
    registerExtractNotebookFrameJob(engine)
    registerProcessImageJob(engine)

    const defs = new Map(
      videobookDomainDefs(scopedBookEngine, books).map((def) => [def.name, def]),
    )
    defs.set('extract_notebook_frame', extractNotebookFrameDef(engine))
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
      '-i', `color=c=blue:s=64x64:r=24:d=${clipSeconds}`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      sourcePath,
    ])
    const artifact = await engine.artifacts.create({
      kind: 'video',
      label: 'source',
    })
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) throw new Error(artifact.error.message)
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
        label: 'Source clip',
        slot: { row: 0, column: 0 },
        output_artifact_id: artifact.value.artifactId,
      },
    }) as { id: string }
    return {
      engine,
      callTool,
      defs,
      notebookId,
      sourceCellId: source.id,
      sourceArtifactId: artifact.value.artifactId,
      bookId: bookId!,
    }
  }

  it('parses direct first and last frame requests without claiming other prompts', () => {
    expect(parseNotebookFrameCommand(
      'extract the first frame of @a1',
    )).toEqual({
      frameMode: 'first',
      sourceReference: 'a1',
    })
    expect(parseNotebookFrameCommand(
      'Please capture last frame from @019F0000-0D31-7D96-8C0F-800000000001.',
    )).toEqual({
      frameMode: 'last',
      sourceReference: '019f0000-0d31-7d96-8c0f-800000000001',
    })
    expect(parseNotebookFrameCommand(
      'grab the first frame from @H64',
    )).toEqual({
      frameMode: 'first',
      sourceReference: 'h64',
    })
    expect(parseNotebookFrameCommand(
      'extracte the first frame of @a2',
    )).toEqual({
      frameMode: 'first',
      sourceReference: 'a2',
    })
    expect(parseNotebookFrameCommand(
      'generate an image inspired by @a1',
    )).toBeNull()
  })

  it('extracts a frame into a new image cell wired to its source', async () => {
    const harness = await setup('frame-command', 1)
    const { engine, callTool, notebookId, sourceCellId, sourceArtifactId } = harness
    await callTool('create_notebook_cell', {
      book_id: harness.bookId,
      notebook_id: notebookId,
      cell: {
        type: 'image',
        label: 'Reference image',
        slot: { row: 0, column: 1 },
      },
    })
    const beforeResult = engine.notebooks.read(notebookId)
    expect(beforeResult.ok).toBe(true)
    if (!beforeResult.ok) return
    const before: NotebookDocument = beforeResult.value

    const command = parseNotebookFrameCommand(
      'extract the first frame of @a1',
    )!
    const firstRun = await enqueueNotebookFrameCommand({
      actor: 'frame-command-test',
      bookId: harness.bookId,
      callTool,
      command,
      document: before,
    })
    expect(firstRun).toMatchObject({
      reusedAction: false,
      sourceCellId,
      sourceAddress: '@a1',
      actionAddress: '@c1',
    })
    expect(firstRun.outputCellId).toBe(firstRun.actionCellId)
    await waitForJob(firstRun.jobId)

    const completedResult = engine.notebooks.read(notebookId)
    expect(completedResult.ok).toBe(true)
    if (!completedResult.ok) return
    const completed: NotebookDocument = completedResult.value
    const frameCell = completed.cells.find((cell) =>
      cell.id === firstRun.actionCellId)
    expect(frameCell).toMatchObject({
      type: 'image',
      label: 'First frame',
      outputArtifactId: expect.any(String),
      inputs: expect.objectContaining({
        mediaRole: 'extract-frame-output',
        sourceCellId,
        frameMode: 'first',
        atSeconds: 0,
        state: 'completed',
      }),
    })
    expect(frameCell?.operation).toBeUndefined()
    expect(completed.execution?.[firstRun.actionCellId]).toMatchObject({
      status: 'completed',
      outputArtifactId: frameCell?.outputArtifactId,
      tool: 'ffmpeg',
    })
    expect(completed.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: sourceCellId,
        target: firstRun.actionCellId,
        targetInput: 'segment',
      }),
    ]))
    expect(completed.edges.some((edge) =>
      edge.targetInput === 'media')).toBe(false)

    const artifactId = frameCell!.outputArtifactId!
    await waitForManifestFile(engine, artifactId, 'original.jpg')
    const metadata = await engine.metadata.artifacts.read<{
      origin?: string
      sourceArtifactId?: string
      frameMode?: string
      atSeconds?: number
    }>(artifactId, 'original')
    expect(metadata.ok && metadata.value).toMatchObject({
      origin: 'extract_frame',
      sourceArtifactId,
      frameMode: 'first',
      atSeconds: 0,
    })
    await waitForManifestFile(engine, artifactId, 'landscape.jpg')

    const secondRun = await enqueueNotebookFrameCommand({
      actor: 'frame-command-test',
      bookId: harness.bookId,
      callTool,
      command,
      document: completed,
    })
    expect(secondRun.reusedAction).toBe(false)
    expect(secondRun.actionCellId).not.toBe(firstRun.actionCellId)
    expect(secondRun.actionAddress).toBe('@d1')
    await waitForJob(secondRun.jobId)
    const afterSecond = engine.notebooks.read(notebookId)
    expect(afterSecond.ok).toBe(true)
    if (!afterSecond.ok) return
    expect(afterSecond.value.cells.filter((cell) =>
      cell.inputs?.mediaRole === 'extract-frame-output')).toHaveLength(2)
  }, 30_000)

  it('clamps timestamp extractions and rejects invalid requests', async () => {
    const harness = await setup('frame-time-command', 2)
    const { engine, callTool, defs, notebookId, sourceCellId } = harness
    const beforeResult = engine.notebooks.read(notebookId)
    expect(beforeResult.ok).toBe(true)
    if (!beforeResult.ok) return

    const timedRun = await enqueueNotebookFrameCommand({
      actor: 'frame-time-test',
      bookId: harness.bookId,
      callTool,
      command: {
        frameMode: 'time',
        sourceReference: 'a1',
        timestampSeconds: 0.5,
      },
      document: beforeResult.value,
    })
    await waitForJob(timedRun.jobId)
    const afterTimed = engine.notebooks.read(notebookId)
    expect(afterTimed.ok).toBe(true)
    if (!afterTimed.ok) return
    expect(afterTimed.value.cells.find((cell) =>
      cell.id === timedRun.actionCellId)).toMatchObject({
      type: 'image',
      label: 'Frame at 0.5s',
      inputs: expect.objectContaining({
        frameMode: 'time',
        timestampSeconds: 0.5,
        atSeconds: 0.5,
        state: 'completed',
      }),
    })

    const clampedRun = await enqueueNotebookFrameCommand({
      actor: 'frame-time-test',
      bookId: harness.bookId,
      callTool,
      command: {
        frameMode: 'time',
        sourceReference: 'a1',
        timestampSeconds: 9.5,
      },
      document: afterTimed.value,
    })
    await waitForJob(clampedRun.jobId)
    const afterClamped = engine.notebooks.read(notebookId)
    expect(afterClamped.ok).toBe(true)
    if (!afterClamped.ok) return
    const clampedCell = afterClamped.value.cells.find((cell) =>
      cell.id === clampedRun.actionCellId)
    expect(clampedCell?.inputs?.state).toBe('completed')
    expect(Number(clampedCell?.inputs?.atSeconds)).toBeLessThan(2)
    expect(Number(clampedCell?.inputs?.atSeconds)).toBeGreaterThan(1.5)

    const lastRun = await enqueueNotebookFrameCommand({
      actor: 'frame-time-test',
      bookId: harness.bookId,
      callTool,
      command: { frameMode: 'last', sourceReference: 'a1' },
      document: afterClamped.value,
    })
    await waitForJob(lastRun.jobId)
    const afterLast = engine.notebooks.read(notebookId)
    expect(afterLast.ok).toBe(true)
    if (!afterLast.ok) return
    const lastCell = afterLast.value.cells.find((cell) =>
      cell.id === lastRun.actionCellId)
    expect(lastCell?.label).toBe('Last frame')
    expect(Number(lastCell?.inputs?.atSeconds)).toBeGreaterThan(1.9)

    const tool = defs.get('extract_notebook_frame')!
    const missingTimestamp = await withBookContext(
      { bookId: harness.bookId, engine },
      async () => tool.handler({
        book_id: harness.bookId,
        notebook_id: notebookId,
        source_cell_id: sourceCellId,
        frame_mode: 'time',
      }),
    )
    expect(missingTimestamp.isError).toBe(true)
    expect(missingTimestamp.content[0]?.text).toContain('timestamp_seconds')

    const promptCell = await callTool('create_notebook_cell', {
      book_id: harness.bookId,
      notebook_id: notebookId,
      cell: {
        type: 'prompt',
        label: 'Not a video',
        slot: { row: 5, column: 0 },
      },
    }) as { id: string }
    const wrongSource = await withBookContext(
      { bookId: harness.bookId, engine },
      async () => tool.handler({
        book_id: harness.bookId,
        notebook_id: notebookId,
        source_cell_id: promptCell.id,
        frame_mode: 'first',
      }),
    )
    expect(wrongSource.isError).toBe(true)
    expect(wrongSource.content[0]?.text).toContain('not a video-producing cell')
  }, 30_000)
})
