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
  enqueueNotebookSplitCommand,
  notebookSplitCutPoints,
  notebookSplitRanges,
  parseNotebookSplitCommand,
  planNotebookSplitCommand,
} from '../../src/videobook/notebook-split-command'

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
      throw new Error(status.error?.message ?? 'Notebook split failed')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Notebook split did not complete')
}

describe('notebook split commands', () => {
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

  it('parses chat and slash phrasing without claiming timeline edits', () => {
    expect(parseNotebookSplitCommand(
      'split @019abcde into 15s and the remaining',
    )).toEqual({
      sourceReference: '019abcde',
      cutPointsSeconds: [15],
    })
    expect(parseNotebookSplitCommand(
      '/split @019ABCDE at 1:05',
    )).toEqual({
      sourceReference: '019abcde',
      cutPointsSeconds: [65],
    })
    expect(parseNotebookSplitCommand(
      'split @A1 at 2s',
    )).toEqual({
      sourceReference: 'a1',
      cutPointsSeconds: [2],
    })
    expect(parseNotebookSplitCommand(
      'please split @019abcde into 1m 5s plus the rest please',
    )).toEqual({
      sourceReference: '019abcde',
      cutPointsSeconds: [65],
    })
    expect(parseNotebookSplitCommand(
      'split clip @01900000-0000-7000-8000-000000000001 at frame 45',
    )).toBeNull()
    expect(parseNotebookSplitCommand('/split @019abcde')).toEqual({
      sourceReference: '019abcde',
      cutPointsSeconds: [],
    })
    expect(parseNotebookSplitCommand('/split @a1 at 8s, 2.5s and 5s'))
      .toEqual({
        sourceReference: 'a1',
        cutPointsSeconds: [2.5, 5, 8],
      })
    expect(() => parseNotebookSplitCommand('/split @019abcde at later'))
      .toThrow('Use positive split times')
  })

  it('defaults to the midpoint and enforces usable contiguous chunks', () => {
    expect(notebookSplitCutPoints({
      cutPointsSeconds: [],
      sourceDurationSeconds: 9,
    })).toEqual([4.5])
    expect(notebookSplitRanges({
      cutPointsSeconds: [2, 5],
      sourceDurationSeconds: 8,
    })).toEqual([
      { startSeconds: 0, endSeconds: 2 },
      { startSeconds: 2, endSeconds: 5 },
      { startSeconds: 5, endSeconds: 8 },
    ])
    expect(() => notebookSplitCutPoints({
      cutPointsSeconds: [0.25, 2],
      sourceDurationSeconds: 3,
    })).toThrow('Keep at least 0.5s')
    expect(() => notebookSplitCutPoints({
      cutPointsSeconds: [1, 1],
      sourceDurationSeconds: 3,
    })).toThrow('Keep at least 0.5s')
  })

  it('runs one split operation into multiple playable video tiles', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-split-command-'))
    books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
      catalogBackupName: 'backup',
    })
    await books.ready()
    const created = await books.create('split-command')
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
      '-i', 'testsrc2=s=96x64:r=24:d=3',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      sourcePath,
    ])
    const artifact = await engine.artifacts.create({
      kind: 'video',
      label: 'Source video',
    })
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    expect((await engine.files.writeFromPath(
      artifact.value.artifactId,
      'original.mp4',
      sourcePath,
    )).ok).toBe(true)
    expect((await engine.metadata.artifacts.write(
      artifact.value.artifactId,
      'original',
      { duration: 3, height: 64, width: 96 },
    )).ok).toBe(true)

    const source = await callTool('create_notebook_cell', {
      book_id: bookId,
      notebook_id: notebookId,
      cell: {
        type: 'video',
        label: 'Source video',
        slot: { row: 0, column: 0 },
        output_artifact_id: artifact.value.artifactId,
      },
    }) as { id: string; address: string }
    expect(source.address).toBe('@a1')
    const beforeResult = engine.notebooks.read(notebookId)
    expect(beforeResult.ok).toBe(true)
    if (!beforeResult.ok) return
    const before: NotebookDocument = beforeResult.value
    const command = parseNotebookSplitCommand(
      'split @a1 at 1s, 2s',
    )!
    const draft = planNotebookSplitCommand({
      command,
      document: before,
      sourceDurationSeconds: 3,
    })
    expect(draft.createdCellIds).toHaveLength(4)
    expect(draft.sourceAddress).toBe('@a1')
    expect(draft.actionCell).toMatchObject({
      type: 'split_video',
      label: 'Split into 3 chunks',
      operation: 'split_at_points',
      slot: { row: 1, column: 0 },
      inputs: {
        startSeconds: 0,
        cutPointsSeconds: [1, 2],
        endSeconds: 3,
      },
    })
    expect(draft.outputs).toMatchObject([
      {
        chunkIndex: 0,
        outputCell: {
          type: 'video',
          label: 'Chunk 01',
          slot: { row: 2, column: 0 },
          inputs: { chunkCount: 3, chunkIndex: 0, state: 'pending' },
        },
      },
      {
        chunkIndex: 1,
        outputCell: {
          type: 'video',
          label: 'Chunk 02',
          slot: { row: 3, column: 0 },
          inputs: { chunkCount: 3, chunkIndex: 1, state: 'pending' },
        },
      },
      {
        chunkIndex: 2,
        outputCell: {
          type: 'video',
          label: 'Chunk 03',
          slot: { row: 4, column: 0 },
          inputs: { chunkCount: 3, chunkIndex: 2, state: 'pending' },
        },
      },
    ])

    const run = await enqueueNotebookSplitCommand({
      actor: 'split-command-test',
      bookId,
      callTool,
      draft,
    })
    expect(run.outputs).toHaveLength(3)
    expect(run.sourceAddress).toBe('@a1')
    expect(run.actionAddress).toBe('@b1')
    expect(run.outputs.map((output) => output.outputAddress))
      .toEqual(['@c1', '@d1', '@e1'])
    const activeResult = engine.notebooks.read(notebookId)
    expect(activeResult.ok).toBe(true)
    if (!activeResult.ok) return
    expect(['queued', 'running', 'completed']).toContain(
      activeResult.value.execution?.[run.actionCellId]?.status,
    )

    await waitForJob(run.jobId)
    const completedResult = engine.notebooks.read(notebookId)
    expect(completedResult.ok).toBe(true)
    if (!completedResult.ok) return
    const completed = completedResult.value
    expect(completed.cells.filter((cell) => cell.type === 'split_video'))
      .toHaveLength(1)
    expect(completed.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: source.id,
        target: run.actionCellId,
        targetInput: 'video',
      }),
      ...run.outputs.map((output) =>
        expect.objectContaining({
          source: run.actionCellId,
          target: output.outputCellId,
          targetInput: 'media',
        }),
      ),
    ]))
    const outputArtifactIds: string[] = []
    const outputDurations = run.outputs.map((outputRun) => {
      const output = completed.cells.find((cell) =>
        cell.id === outputRun.outputCellId)
      expect(output).toMatchObject({
        type: 'video',
        outputArtifactId: expect.any(String),
        inputs: { state: 'completed' },
      })
      outputArtifactIds.push(output!.outputArtifactId!)
      return Number(output?.inputs?.durationSeconds)
    })
    expect(new Set(outputArtifactIds)).toHaveProperty('size', 3)
    for (const duration of outputDurations) {
      expect(duration).toBeGreaterThan(0.8)
      expect(duration).toBeLessThan(1.2)
    }

    const rerun = await callTool('run_notebook_cell', {
      actor: 'split-command-test',
      book_id: bookId,
      notebook_id: notebookId,
      cell_id: run.actionCellId,
    }) as { job_id: string }
    await waitForJob(rerun.job_id)
    const rerunResult = engine.notebooks.read(notebookId)
    expect(rerunResult.ok).toBe(true)
    if (!rerunResult.ok) return
    expect(rerunResult.value.cells.filter((cell) => cell.type === 'split_video'))
      .toHaveLength(1)
    const rerunOutputs = run.outputs.map((outputRun) =>
      rerunResult.value.cells.find((cell) => cell.id === outputRun.outputCellId)!)
    const rerunArtifactIds = rerunOutputs.map((output) =>
      output.outputArtifactId!)
    expect(new Set(rerunArtifactIds)).toHaveProperty('size', 3)
    for (const [index, output] of rerunOutputs.entries()) {
      expect(output.outputArtifactId).not.toBe(outputArtifactIds[index])
      expect(output.inputs?.outputVersionArtifactIds).toEqual(
        expect.arrayContaining([
          outputArtifactIds[index],
          output.outputArtifactId,
        ]),
      )
    }
  }, 45_000)
})
