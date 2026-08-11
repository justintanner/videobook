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
  enqueueNotebookAudioCommand,
  resolveNotebookAudioSource,
} from '../../src/videobook/notebook-audio-command'

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
      throw new Error(status.error?.message ?? 'Audio extraction failed')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Audio extraction did not complete')
}

describe('notebook audio commands', () => {
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

  it('creates, runs, and reuses a horizontal Extract Audio workflow', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-audio-command-'))
    books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    await books.ready()
    const created = await books.create('audio-command')
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
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:sample_rate=44100:duration=1',
      '-shortest',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      sourcePath,
    ])
    const artifact = await engine.artifacts.create({
      kind: 'video',
      label: 'source',
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
        label: 'Source clip',
        slot: { row: 0, column: 0 },
        output_artifact_id: artifact.value.artifactId,
      },
    }) as { id: string }
    await callTool('create_notebook_cell', {
      book_id: bookId,
      notebook_id: notebookId,
      cell: {
        type: 'image',
        label: 'Occupied neighbor',
        slot: { row: 0, column: 1 },
      },
    })
    const beforeResult = engine.notebooks.read(notebookId)
    expect(beforeResult.ok).toBe(true)
    if (!beforeResult.ok) return
    const before: NotebookDocument = beforeResult.value

    expect(resolveNotebookAudioSource(before, 'a1').id).toBe(source.id)
    expect(() => resolveNotebookAudioSource(before, 'a2'))
      .toThrow('@a2 is not a video-producing cell')

    const firstRun = await enqueueNotebookAudioCommand({
      actor: 'audio-command-test',
      bookId,
      callTool,
      command: { sourceReference: 'a1' },
      document: before,
    })
    expect(firstRun).toMatchObject({
      reusedAction: false,
      sourceCellId: source.id,
      sourceAddress: '@a1',
      actionAddress: '@a3',
      outputCellId: expect.any(String),
    })
    await waitForJob(firstRun.jobId)

    const completedResult = engine.notebooks.read(notebookId)
    expect(completedResult.ok).toBe(true)
    if (!completedResult.ok) return
    const completed = completedResult.value
    const action = completed.cells.find((cell) =>
      cell.id === firstRun.actionCellId)
    const output = completed.cells.find((cell) =>
      cell.id === firstRun.outputCellId)
    expect(action).toMatchObject({
      type: 'extract_audio',
      label: 'Extract audio',
      slot: { row: 0, column: 2 },
      operation: 'extract_audio',
    })
    expect(output).toMatchObject({
      type: 'audio',
      slot: { row: 0, column: 3 },
      outputArtifactId: expect.any(String),
      inputs: {
        mediaRole: 'extract-audio-output',
        producerCellId: firstRun.actionCellId,
        state: 'completed',
      },
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
    const manifest = await engine.files.manifest(output!.outputArtifactId!)
    expect(manifest.ok).toBe(true)
    expect(manifest.ok && manifest.value.files.some((file) =>
      file.name === 'original.m4a')).toBe(true)

    const secondRun = await enqueueNotebookAudioCommand({
      actor: 'audio-command-test',
      bookId,
      callTool,
      command: { sourceReference: 'a1' },
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
