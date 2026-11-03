import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { registerAllJobHandlers } from '../../server/src/jobs/index.js'
import { getVideoEditingToolDefs } from '../../server/src/tools/index.js'
import {
  queue,
  setEngineRoot,
  stopBookQueue,
} from '../../server/src/queue.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'
import { MINIMUM_SPLIT_PIECE_SECONDS } from '../../server/src/notebook-media-ops.js'
import {
  applyNotebookSplitCommand,
  compileNotebookSplitOutputs,
  minimumSplitPieceSeconds,
  notebookClipRun,
  notebookSplitCutPoints,
  notebookSplitRanges,
  parseNotebookSplitCommand,
  routedNotebookSplitCommand,
  trimSplitSelection,
  type NotebookSplitCommand,
} from '../../src/videobook/notebook-split-command'
import { testBudget } from '../../server/src/test-budget.js'

const execFileAsync = promisify(execFile)

function resultJson(result: Awaited<ReturnType<ToolDef['handler']>>): unknown {
  if (result.isError) throw new Error(result.content[0]?.text ?? 'Tool failed')
  return JSON.parse(result.content[0]!.text) as unknown
}

async function waitForJob(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < testBudget(400); attempt += 1) {
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
    for (const phrase of ['/split @e1 at scenes', 'split @E1 into scenes', '/split @e1 by camera cuts', '/split @e1 scenes']) {
      expect(parseNotebookSplitCommand(phrase)).toEqual({
        sourceReference: 'e1',
        cutPointsSeconds: [],
        cutSource: 'scenes',
      })
    }
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

  it('maps chat trims onto the review sheet selection', () => {
    expect(trimSplitSelection({ tailSeconds: 2 }, 10)).toEqual({
      cutPointsSeconds: [8],
      outputMode: 'remove',
      selectedChunkIndexes: [1],
    })
    expect(trimSplitSelection({ headSeconds: 3 }, 10)).toEqual({
      cutPointsSeconds: [3],
      outputMode: 'remove',
      selectedChunkIndexes: [0],
    })
    expect(trimSplitSelection({ keepStart: 2, keepEnd: 6 }, 10)).toEqual({
      cutPointsSeconds: [2, 6],
      outputMode: 'keep',
      selectedChunkIndexes: [1],
    })
    expect(trimSplitSelection({ cuts: [{ startSeconds: 4, endSeconds: 5 }] }, 10)).toEqual({
      cutPointsSeconds: [4, 5],
      outputMode: 'remove',
      selectedChunkIndexes: [1],
    })
    expect(routedNotebookSplitCommand({
      tool: 'trim_video',
      params: { asset_id: '@a1', tail_seconds: 2 },
      sourceReference: 'a1',
    })).toEqual({
      sourceReference: 'a1',
      cutPointsSeconds: [],
      trim: { tailSeconds: 2, keepStart: undefined, keepEnd: undefined, headSeconds: undefined },
      destination: 'new',
    })
    expect(routedNotebookSplitCommand({
      tool: 'split_video',
      params: { durations: [2, '3s'] },
      sourceReference: 'a1',
    })).toEqual({ sourceReference: 'a1', cutPointsSeconds: [2, 5] })
    expect(routedNotebookSplitCommand({
      tool: 'split_video',
      params: { scenes: true },
      sourceReference: 'a1',
    })).toEqual({ sourceReference: 'a1', cutPointsSeconds: [], cutSource: 'scenes' })
  })

  it('applies KEEP, REMOVE, ALL and in-place trims with real ffmpeg and no action cell', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-split-modes-'))
    books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
      catalogBackupName: 'backup',
    })
    await books.ready()
    const created = await books.create('split-modes')
    if (!created.ok) throw new Error(created.error.message)
    bookId = created.value.bookId
    const managed = books.get(bookId)
    if (!managed.ok) throw new Error(managed.error.message)
    const engine = managed.value.engine
    await setEngineRoot(rootDir, engine)
    registerAllJobHandlers(engine, books)

    const defs = new Map([
      ...videobookDomainDefs(scopedBookEngine, books),
      ...getVideoEditingToolDefs(scopedBookEngine),
    ].map((def) => [def.name, def]))
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
    const artifact = await engine.artifacts.create({ kind: 'video', label: 'Source video' })
    if (!artifact.ok) throw new Error(artifact.error.message)
    expect((await engine.files.writeFromPath(artifact.value.artifactId, 'original.mp4', sourcePath)).ok).toBe(true)
    await callTool('create_notebook_cell', {
      book_id: bookId,
      notebook_id: notebookId,
      cell: {
        type: 'video',
        label: 'Source video',
        slot: { row: 0, column: 0 },
        output_artifact_id: artifact.value.artifactId,
      },
    })

    const apply = async (command: NotebookSplitCommand): Promise<number[]> => {
      const results = await applyNotebookSplitCommand({
        bookId: bookId!,
        callTool,
        command,
        notebookId,
        sourceDurationSeconds: 3,
      })
      const runs = results.map(notebookClipRun).filter((run) => run !== null)
      for (const run of runs) await waitForJob(run.jobId)
      const notebook = engine.notebooks.read(notebookId)
      if (!notebook.ok) throw new Error(notebook.error.message)
      return runs.flatMap((run) => run.outputs).map((output) => Number(
        notebook.value.cells.find((cell) => cell.id === output.cellId)?.inputs?.durationSeconds,
      ))
    }
    const frame = 1 / 24
    const command: NotebookSplitCommand = { sourceReference: 'a1', cutPointsSeconds: [0.5, 1.5] }

    const [kept] = await apply({ ...command, outputMode: 'keep', selectedChunkIndexes: [1] })
    expect(Math.abs(kept! - 1)).toBeLessThanOrEqual(frame + 0.02)
    const [removed] = await apply({ ...command, outputMode: 'remove', selectedChunkIndexes: [1] })
    expect(Math.abs(removed! - 2)).toBeLessThanOrEqual(frame + 0.05)
    const all = await apply({ ...command, outputMode: 'all' })
    expect(all).toHaveLength(3)

    const notebook = engine.notebooks.read(notebookId)
    if (!notebook.ok) throw new Error(notebook.error.message)
    expect(notebook.value.cells.filter((cell) => cell.type === 'split_video')).toEqual([])
    expect(notebook.value.cells).toHaveLength(6)

    const inPlace = await apply({
      ...command,
      outputMode: 'remove',
      selectedChunkIndexes: [2],
      destination: 'in_place',
    })
    expect(inPlace).toEqual([])
    const manifest = await engine.files.manifest(artifact.value.artifactId)
    if (!manifest.ok) throw new Error(manifest.error.message)
    const probe = await probeVideo(join(manifest.value.path, 'original.mp4'))
    expect(Math.abs(probe.duration - 1.5)).toBeLessThanOrEqual(0.1)
  }, testBudget(180_000))
})
