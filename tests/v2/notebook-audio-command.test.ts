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
import { registerExtractNotebookAudioJob } from '../../server/src/jobs/extract-notebook-audio.js'
import { registerRunNotebookJob } from '../../server/src/jobs/run-notebook.js'
import { extractNotebookAudioDef } from '../../server/src/tools/extract-notebook-audio.js'
import {
  queue,
  setEngineRoot,
  stopBookQueue,
} from '../../server/src/queue.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'
import { enqueueNotebookAudioCommand } from '../../src/videobook/notebook-audio-command'

const execFileAsync = promisify(execFile)

function resultJson(result: Awaited<ReturnType<ToolDef['handler']>>): unknown {
  if (result.isError) throw new Error(result.content[0]?.text ?? 'Tool failed')
  return JSON.parse(result.content[0]!.text) as unknown
}

async function waitForJob(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = await queue.getStatus(jobId)
    if (status?.state === 'completed') return
    if (status?.state === 'failed') {
      throw new Error(status.error?.message ?? 'Audio extraction failed')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Audio extraction did not complete')
}

function executionOf(
  document: NotebookDocument,
  cellId: string,
): Record<string, unknown> {
  const execution = (document.execution ?? {}) as Record<string, Record<string, unknown>>
  return execution[cellId] ?? {}
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

  it('creates, runs, re-runs, and attaches to a horizontal Extract Audio workflow', async () => {
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
    registerExtractNotebookAudioJob(engine)
    registerRunNotebookJob(engine)

    const defs = new Map(
      [
        ...videobookDomainDefs(scopedBookEngine, books),
        extractNotebookAudioDef(engine),
      ].map((def) => [def.name, def]),
    )
    const calledTools: string[] = []
    const callTool = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      const def = defs.get(name)
      if (!def) throw new Error(`Missing ${name}`)
      calledTools.push(name)
      return await withBookContext(
        { bookId: bookId!, engine },
        async () => resultJson(await def.handler(args)),
      )
    }
    const readNotebook = (notebookId: string): NotebookDocument => {
      const read = engine.notebooks.read(notebookId)
      if (!read.ok) throw new Error(read.error.message)
      return read.value
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
    const before = readNotebook(notebookId)

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
      outputCellId: firstRun.actionCellId,
    })
    expect(calledTools.at(-1)).toBe('extract_notebook_audio')
    await waitForJob(firstRun.jobId)

    const completed = readNotebook(notebookId)
    const action = completed.cells.find((cell) =>
      cell.id === firstRun.actionCellId)
    expect(action).toMatchObject({
      type: 'audio',
      label: 'Extract audio',
      slot: { row: 0, column: 2 },
      outputArtifactId: expect.any(String),
      inputs: expect.objectContaining({
        state: 'completed',
        mediaRole: 'extract-audio-output',
        sourceCellId: source.id,
      }),
    })
    expect(executionOf(completed, firstRun.actionCellId)).toMatchObject({
      status: 'completed',
      runId: firstRun.runId,
    })
    expect(completed.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: source.id,
        target: firstRun.actionCellId,
        targetInput: 'segment',
      }),
    ]))
    expect(completed.edges.some((edge) =>
      edge.source === firstRun.actionCellId && edge.targetInput === 'media'))
      .toBe(false)
    const firstArtifactId = action!.outputArtifactId!
    const manifest = await engine.files.manifest(firstArtifactId)
    expect(manifest.ok).toBe(true)
    expect(manifest.ok && manifest.value.files.some((file) =>
      file.name === 'original.m4a')).toBe(true)

    // Asking again for a source that already has its audio cell must re-run
    // that cell through the server, so the caller watches a real run instead
    // of a placeholder that never completes.
    const secondRun = await enqueueNotebookAudioCommand({
      actor: 'audio-command-test',
      bookId,
      callTool,
      command: { sourceReference: 'a1' },
      document: completed,
    })
    expect(secondRun).toMatchObject({
      actionCellId: firstRun.actionCellId,
      actionAddress: '@a3',
      outputCellId: firstRun.actionCellId,
      reusedAction: true,
      sourceCellId: source.id,
    })
    expect(calledTools.at(-1)).toBe('run_notebook_cell')
    expect(secondRun.runId).not.toBe(firstRun.runId)
    expect(secondRun.jobId).toMatch(/^run-notebook-/)

    const queued = readNotebook(notebookId)
    expect(executionOf(queued, firstRun.actionCellId)).toMatchObject({
      status: 'queued',
      runId: secondRun.runId,
    })

    // While that re-run is still in flight, a repeated request attaches to it
    // rather than stacking another run on the same cell.
    const toolCallsBeforeAttach = calledTools.length
    const attached = await enqueueNotebookAudioCommand({
      actor: 'audio-command-test',
      bookId,
      callTool,
      command: { sourceReference: 'a1' },
      document: queued,
    })
    expect(attached).toMatchObject({
      actionCellId: firstRun.actionCellId,
      reusedAction: true,
      runId: secondRun.runId,
      jobId: '',
    })
    expect(calledTools.length).toBe(toolCallsBeforeAttach)

    await waitForJob(secondRun.jobId)
    const rerun = readNotebook(notebookId)
    const rerunAction = rerun.cells.find((cell) =>
      cell.id === firstRun.actionCellId)
    expect(executionOf(rerun, firstRun.actionCellId)).toMatchObject({
      status: 'completed',
      runId: secondRun.runId,
    })
    expect(rerunAction?.outputArtifactId).toEqual(expect.any(String))
    expect(rerunAction?.outputArtifactId).not.toBe(firstArtifactId)
    expect(rerunAction?.inputs?.outputVersionArtifactIds).toEqual(
      expect.arrayContaining([firstArtifactId, rerunAction!.outputArtifactId!]),
    )
    const rerunManifest = await engine.files.manifest(rerunAction!.outputArtifactId!)
    expect(rerunManifest.ok && rerunManifest.value.files.some((file) =>
      file.name === 'original.m4a')).toBe(true)
  }, 60_000)
})
