import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine, NOTEBOOK_CELL_TYPES, SCHEMA_VERSION, type Engine } from 'videobook-engine'
import { FFMPEG } from '../../server/src/ffmpeg.js'
import { topologicalOrder } from '../../server/src/jobs/run-notebook.js'
import { listNotebookActions } from '../../server/src/notebook-action-catalog.js'
import { captureFrame, extractSourceAudio, splitSourceRange } from '../../server/src/notebook-media-ops.js'
import { applyAnalysisResults, buildSevenStageScaffold, WORKFLOW_STAGES } from '../../server/src/notebook-workflow.js'

const execFileAsync = promisify(execFile)

describe('transparent runnable DAG e2e (offline)', () => {
  let rootDir: string | undefined
  let engine: Engine | undefined

  afterEach(async () => {
    engine?.close()
    if (rootDir) {
      await rm(rootDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      })
    }
  })

  it('runs source→analysis fixture→split/audio/frame without paid generation', async () => {
    expect(SCHEMA_VERSION).toBe(9)
    expect(NOTEBOOK_CELL_TYPES).toHaveLength(18)
    expect(WORKFLOW_STAGES).toHaveLength(8)
    expect(WORKFLOW_STAGES).toEqual([
      'SOURCE',
      'ANALYZE',
      'SPLIT SCENES',
      'EXTRACT ASSETS',
      'WRITE PROMPTS',
      'ANIMATE SCENES',
      'ASSEMBLE EDIT',
      'EXPORT MASTER',
    ])
    expect(listNotebookActions().some((action) => action.operation === 'analyze_source')).toBe(true)

    rootDir = await mkdtemp(join(tmpdir(), 'videobook-dag-e2e-'))
    engine = createEngine({ rootDir, initialBookSlug: 'dag-e2e' })
    await engine.ready

    const sourcePath = join(rootDir, 'source.mp4')
    await execFileAsync(FFMPEG, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=8',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=8',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      sourcePath,
    ])
    const sourceArtifact = await engine.artifacts.create({ kind: 'video', name: 'source' })
    expect(sourceArtifact.ok).toBe(true)
    if (!sourceArtifact.ok) return
    await engine.files.writeFromPath(sourceArtifact.value.artifactId, 'original.mp4', sourcePath)

    const notebook = await engine.notebooks.create('Main')
    expect(notebook.ok).toBe(true)
    if (!notebook.ok) return
    const scaffold = buildSevenStageScaffold(engine, notebook.value, sourceArtifact.value.artifactId)
    const analysis = scaffold.cells.find((cell) => cell.type === 'analysis')!
    const withFixture = {
      ...scaffold,
      cells: scaffold.cells.map((cell) => cell.id === analysis.id
        ? {
            ...cell,
            inputs: {
              ...cell.inputs,
              sourceDurationSeconds: 8,
              fixtureAnalysis: {
                scenes: [
                  { title: 'a', timestamp: [0, 4] },
                  { title: 'b', timestamp: [4, 8] },
                ],
              },
            },
          }
        : cell),
    }
    const fanned = await applyAnalysisResults(engine, withFixture, analysis.id, {
      rawOutput: withFixture.cells.find((cell) => cell.id === analysis.id)?.inputs?.fixtureAnalysis,
      sourceDurationSeconds: 8,
      request: { mode: 'fixture' },
      sourceArtifactId: sourceArtifact.value.artifactId,
    })
    expect(fanned.cells.filter((cell) => cell.type === 'label')).toEqual([])
    expect(fanned.properties?.stageLabels).toBeUndefined()
    expect(fanned.properties?.featureLanes).toBeUndefined()
    expect(fanned.cells.filter((cell) => cell.type === 'split')).toHaveLength(2)
    expect(fanned.cells.filter((cell) => cell.type === 'frame')).toHaveLength(4)
    expect(fanned.cells.filter((cell) => cell.type === 'prompt')).toHaveLength(2)
    expect(fanned.cells.filter((cell) => cell.type === 'video')).toHaveLength(2)
    expect(topologicalOrder(fanned).length).toBe(fanned.cells.length)

    const splitCell = fanned.cells.find((cell) => cell.type === 'split')!
    const split = await splitSourceRange(
      engine,
      sourceArtifact.value.artifactId,
      {
        startSeconds: Number(splitCell.inputs?.startSeconds),
        endSeconds: Number(splitCell.inputs?.endSeconds),
      },
      splitCell.title,
    )
    const first = await captureFrame(engine, split.artifactId, { role: 'first', title: 'first' })
    const last = await captureFrame(engine, split.artifactId, { role: 'last', title: 'last' })
    const audio = await extractSourceAudio(engine, sourceArtifact.value.artifactId, 'audio')
    expect(first.artifactId).toBeTruthy()
    expect(last.artifactId).toBeTruthy()
    expect(audio.artifactId).toBeTruthy()

    // Paid prompt rewrite and animation must not auto-start.
    expect(fanned.cells.filter((cell) => cell.type === 'prompt').every((cell) =>
      cell.inputs?.requiresConfirmation === true)).toBe(true)
    expect(fanned.cells.filter((cell) => cell.type === 'video').every((cell) =>
      cell.inputs?.requiresConfirmation === true)).toBe(true)
  }, 90_000)
})
