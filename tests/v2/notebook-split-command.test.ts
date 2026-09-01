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
import { listAssetsDef } from '../../server/src/tools/list-assets.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'
import { MINIMUM_SPLIT_PIECE_SECONDS } from '../../server/src/notebook-media-ops.js'
import {
  enqueueNotebookSplitCommand,
  compileNotebookSplitOutputs,
  minimumSplitPieceSeconds,
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
    expect(parseNotebookSplitCommand('/split @a1 keep 0.03-0.11')).toEqual({
      sourceReference: 'a1',
      cutPointsSeconds: [0.03, 0.11],
      outputMode: 'keep',
      selectedChunkIndexes: [1],
    })
    expect(parseNotebookSplitCommand('/split @a1 remove 0:00.030-0:00.110')).toEqual({
      sourceReference: 'a1',
      cutPointsSeconds: [0.03, 0.11],
      outputMode: 'remove',
      selectedChunkIndexes: [1],
    })
    expect(parseNotebookSplitCommand('/split @a1 keep 1m 5s-70')).toEqual({
      sourceReference: 'a1',
      cutPointsSeconds: [65, 70],
      outputMode: 'keep',
      selectedChunkIndexes: [1],
    })
    expect(() => parseNotebookSplitCommand('/split @019abcde at later'))
      .toThrow('Use positive split times')
  })

  it('defaults to the midpoint and enforces usable output ranges', () => {
    expect(minimumSplitPieceSeconds).toBe(MINIMUM_SPLIT_PIECE_SECONDS)
    expect(notebookSplitCutPoints({
      cutPointsSeconds: [],
      sourceDurationSeconds: 9,
    })).toEqual([4.5])
    expect(notebookSplitCutPoints({
      cutPointsSeconds: [0.03, 0.11],
      sourceDurationSeconds: 30,
    })).toEqual([0.03, 0.11])
    expect(notebookSplitRanges({
      cutPointsSeconds: [2, 5],
      sourceDurationSeconds: 8,
    })).toEqual([
      { startSeconds: 0, endSeconds: 2 },
      { startSeconds: 2, endSeconds: 5 },
      { startSeconds: 5, endSeconds: 8 },
    ])
    expect(() => notebookSplitCutPoints({
      cutPointsSeconds: [0.01, 2],
      sourceDurationSeconds: 3,
    })).toThrow('Keep at least 0.02s')
    expect(() => notebookSplitCutPoints({
      cutPointsSeconds: [1, 1],
      sourceDurationSeconds: 3,
    })).toThrow('Keep at least 0.02s')
    expect(compileNotebookSplitOutputs({
      cutPointsSeconds: [0.01, 0.09],
      outputMode: 'keep',
      selectedChunkIndexes: [1],
      sourceDurationSeconds: 30,
    })).toEqual([[{ startSeconds: 0.01, endSeconds: 0.09 }]])
    expect(compileNotebookSplitOutputs({
      cutPointsSeconds: [0.03, 0.11],
      outputMode: 'remove',
      selectedChunkIndexes: [1],
      sourceDurationSeconds: 30,
    })).toEqual([[
      { startSeconds: 0, endSeconds: 0.03 },
      { startSeconds: 0.11, endSeconds: 30 },
    ]])
  })

  it('plans KEEP and REMOVE as one output cell each', () => {
    const document: NotebookDocument = {
      id: '018f7cf5-0d31-7d96-8c0f-800000000001',
      name: 'Story',
      cells: [{
        id: '018f7cf5-0d31-7d96-8c0f-800000000002',
        type: 'video',
        slot: { row: 0, column: 0 },
        outputArtifactId: '018f7cf5-0d31-7d96-8c0f-800000000004',
      }],
      edges: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const keep = planNotebookSplitCommand({
      command: {
        sourceReference: 'a1',
        cutPointsSeconds: [0.03, 0.11],
        outputMode: 'keep',
        selectedChunkIndexes: [1],
      },
      document,
      sourceDurationSeconds: 30,
    })
    expect(keep.outputs).toHaveLength(1)
    expect(keep.actionCell.operation).toBe('split_ranges')
    expect(keep.outputs[0]?.outputCell).toMatchObject({
      type: 'video',
      label: 'Cut 0:00.030-0:00.110',
      inputs: {
        chunkCount: 1,
        chunkIndex: 0,
        startSeconds: 0.03,
        endSeconds: 0.11,
      },
    })
    expect(keep.actionCell.inputs?.outputsSeconds).toEqual([
      [{ startSeconds: 0.03, endSeconds: 0.11 }],
    ])
    const remove = planNotebookSplitCommand({
      command: {
        sourceReference: 'a1',
        cutPointsSeconds: [0.03, 0.11],
        outputMode: 'remove',
        selectedChunkIndexes: [1],
      },
      document,
      sourceDurationSeconds: 30,
    })
    expect(remove.outputs).toHaveLength(1)
    expect(remove.outputs[0]?.outputCell.label).toBe('Without 0:00.030-0:00.110')
    expect(remove.actionCell.inputs?.outputsSeconds).toEqual([[
      { startSeconds: 0, endSeconds: 0.03 },
      { startSeconds: 0.11, endSeconds: 30 },
    ]])
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
    expect(run.actionAddress).toBe('@a2')
    expect(run.outputs.map((output) => output.outputAddress))
      .toEqual(['@a3', '@a4', '@a5'])
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

  it('proves KEEP, REMOVE, and ALL of 0.03-0.11 with real ffmpeg', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-split-modes-'))
    books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
      catalogBackupName: 'backup',
    })
    await books.ready()
    const created = await books.create('split-modes')
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
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-shortest',
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
      { duration: 3, height: 64, width: 96, fps: 24, hasAudio: true },
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
    const beforeResult = engine.notebooks.read(notebookId)
    expect(beforeResult.ok).toBe(true)
    if (!beforeResult.ok) return
    const before: NotebookDocument = beforeResult.value
    const frame = 1 / 24
    const command = {
      sourceReference: 'a1',
      cutPointsSeconds: [0.03, 0.11],
    }

    const keepDraft = planNotebookSplitCommand({
      command: { ...command, outputMode: 'keep', selectedChunkIndexes: [1] },
      document: before,
      sourceDurationSeconds: 3,
    })
    expect(keepDraft.outputs).toHaveLength(1)
    const keepRun = await enqueueNotebookSplitCommand({
      actor: 'split-keep-test',
      bookId,
      callTool,
      draft: keepDraft,
    })
    await waitForJob(keepRun.jobId)
    const keepDoc = engine.notebooks.read(notebookId)
    expect(keepDoc.ok).toBe(true)
    if (!keepDoc.ok) return
    const keepOutput = keepDoc.value.cells.find((cell) =>
      cell.id === keepRun.outputs[0]!.outputCellId)
    expect(keepOutput).toMatchObject({
      type: 'video',
      outputArtifactId: expect.any(String),
      inputs: { state: 'completed' },
    })
    const keepDuration = Number(keepOutput?.inputs?.durationSeconds)
    expect(keepDuration).toBeGreaterThan(0.08 - frame)
    expect(keepDuration).toBeLessThan(0.08 + frame)
    const sourceAfterKeep = keepDoc.value.cells.find((cell) => cell.id === source.id)
    expect(sourceAfterKeep?.outputArtifactId).toBe(artifact.value.artifactId)
    const keepMeta = await engine.metadata.artifacts.read<Record<string, unknown>>(
      keepOutput!.outputArtifactId!,
      'original',
    )
    expect(keepMeta.ok && Number(keepMeta.value.fps)).toBeGreaterThan(0)
    const listed = await listAssetsDef(engine).handler({
      book_id: bookId,
      sort: 'newest',
      include_referenced: true,
    })
    expect(listed.isError, listed.content[0]?.text).toBeUndefined()
    const listedPayload = JSON.parse(listed.content[0]!.text) as {
      assets: Array<{ artifact_id: string; fps: number | null }>
    }
    expect(listedPayload.assets.find((entry) =>
      entry.artifact_id === keepOutput?.outputArtifactId)?.fps).toBeGreaterThan(0)

    const removeDraft = planNotebookSplitCommand({
      command: { ...command, outputMode: 'remove', selectedChunkIndexes: [1] },
      document: keepDoc.value,
      sourceDurationSeconds: 3,
    })
    expect(removeDraft.outputs).toHaveLength(1)
    const removeRun = await enqueueNotebookSplitCommand({
      actor: 'split-remove-test',
      bookId,
      callTool,
      draft: removeDraft,
    })
    await waitForJob(removeRun.jobId)
    const removeDoc = engine.notebooks.read(notebookId)
    expect(removeDoc.ok).toBe(true)
    if (!removeDoc.ok) return
    const removeOutput = removeDoc.value.cells.find((cell) =>
      cell.id === removeRun.outputs[0]!.outputCellId)
    expect(removeOutput).toMatchObject({
      type: 'video',
      outputArtifactId: expect.any(String),
      inputs: { state: 'completed' },
    })
    const removeDuration = Number(removeOutput?.inputs?.durationSeconds)
    expect(removeDuration).toBeGreaterThan(2.92 - frame)
    expect(removeDuration).toBeLessThan(2.92 + frame)
    const removeMeta = await engine.metadata.artifacts.read<Record<string, unknown>>(
      removeOutput!.outputArtifactId!,
      'original',
    )
    expect(removeMeta.ok && removeMeta.value.hasAudio).toBe(true)

    const allDraft = planNotebookSplitCommand({
      command,
      document: removeDoc.value,
      sourceDurationSeconds: 3,
    })
    expect(allDraft.outputs).toHaveLength(3)
    expect(allDraft.actionCell.operation).toBe('split_at_points')
    const allRun = await enqueueNotebookSplitCommand({
      actor: 'split-all-test',
      bookId,
      callTool,
      draft: allDraft,
    })
    await waitForJob(allRun.jobId)
    const allDoc = engine.notebooks.read(notebookId)
    expect(allDoc.ok).toBe(true)
    if (!allDoc.ok) return
    const allOutputs = allRun.outputs.map((outputRun) =>
      allDoc.value.cells.find((cell) => cell.id === outputRun.outputCellId)!)
    expect(allOutputs).toHaveLength(3)
    for (const output of allOutputs) {
      expect(output.inputs?.state).toBe('completed')
      expect(output.outputArtifactId).toEqual(expect.any(String))
    }
    const middleDuration = Number(allOutputs[1]?.inputs?.durationSeconds)
    expect(middleDuration).toBeGreaterThan(0.08 - frame)
    expect(middleDuration).toBeLessThan(0.08 + frame)
  }, 45_000)
})
