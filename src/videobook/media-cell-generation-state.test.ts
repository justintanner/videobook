import { describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookEdge } from 'videobook-engine'
import { mediaCellGenerationState } from './media-cell-generation-state'
import type { NotebookRunJobView } from './notebook-run-watch'

const producerId = '01900000-0000-7000-8000-000000000001'
const outputId = '01900000-0000-7000-8000-000000000002'

const producer: NotebookCell = {
  id: producerId,
  type: 'generate_video',
  slot: { row: 0, column: 0 },
  prompt: 'A slow dolly through a pine forest',
  provider: 'kie',
  model: 'Kling21RequestSchema',
  operation: 'text_to_video',
}

function outputCell(overrides: Partial<NotebookCell> = {}): NotebookCell {
  return {
    id: outputId,
    type: 'video',
    slot: { row: 0, column: 1 },
    inputs: { mediaRole: 'generate-video-output' },
    ...overrides,
  }
}

const producerEdge: NotebookEdge = {
  id: 'edge-1',
  source: producerId,
  target: outputId,
  targetInput: 'media',
}

function awaitJob(overrides: Partial<NotebookRunJobView> = {}): NotebookRunJobView {
  return {
    state: 'running',
    errorMessage: null,
    operationId: 'job-1',
    type: 'await_notebook_output',
    startedAt: 1_000,
    payload: { outputCellId: outputId, runId: 'run-1' },
    ...overrides,
  }
}

const base = {
  cells: [producer, outputCell()],
  edges: [producerEdge],
}

describe('mediaCellGenerationState', () => {
  it('reports ready for an output with landed media and no active run', () => {
    expect(mediaCellGenerationState({
      ...base,
      cell: outputCell({ outputArtifactId: 'artifact-1' }),
    })).toEqual({ kind: 'ready' })
  })

  it('reports ready for cells that are not generation outputs', () => {
    expect(mediaCellGenerationState({
      cell: { id: 'x', type: 'video', slot: { row: 0, column: 0 } },
      cells: [],
      edges: [],
      queuedCellIds: new Set(['x']),
    })).toEqual({ kind: 'ready' })
  })

  it('reports queued with producer prompt and model while queued', () => {
    expect(mediaCellGenerationState({
      ...base,
      cell: outputCell({ outputArtifactId: 'artifact-1' }),
      queuedCellIds: new Set([outputId]),
    })).toEqual({
      kind: 'queued',
      startedAt: null,
      model: 'Kling21RequestSchema',
      prompt: 'A slow dolly through a pine forest',
      producerCellId: producerId,
      jobId: null,
    })
  })

  it('reports generating with the job start time while the run is active', () => {
    expect(mediaCellGenerationState({
      ...base,
      cell: outputCell({ outputArtifactId: 'artifact-1' }),
      jobs: [awaitJob()],
    })).toEqual({
      kind: 'generating',
      startedAt: new Date(1_000).toISOString(),
      model: 'Kling21RequestSchema',
      prompt: 'A slow dolly through a pine forest',
      producerCellId: producerId,
      jobId: 'job-1',
    })
  })

  it('reports failed with the live run error message', () => {
    expect(mediaCellGenerationState({
      ...base,
      cell: outputCell({ outputArtifactId: 'artifact-1' }),
      runErrors: { [outputId]: 'Provider rejected the request' },
    })).toEqual({
      kind: 'failed',
      message: 'Provider rejected the request',
      producerCellId: producerId,
    })
  })

  it('keeps generating on an output with a stale previous artifact', () => {
    expect(mediaCellGenerationState({
      ...base,
      cell: outputCell({ outputArtifactId: 'artifact-stale' }),
      jobs: [awaitJob({ state: 'running', operationId: 'job-2' })],
    })).toMatchObject({ kind: 'generating', jobId: 'job-2' })
  })

  it('matches legacy awaiting jobs keyed by the producer cell', () => {
    expect(mediaCellGenerationState({
      ...base,
      cell: outputCell(),
      jobs: [awaitJob({
        payload: { cellId: producerId, runId: 'run-1' },
      })],
    })).toMatchObject({ kind: 'generating', jobId: 'job-1' })
  })

  it('ignores finished and unrelated jobs', () => {
    expect(mediaCellGenerationState({
      ...base,
      cell: outputCell({ outputArtifactId: 'artifact-1' }),
      jobs: [
        awaitJob({ state: 'done' }),
        awaitJob({ type: 'generate_video' }),
        awaitJob({ payload: { outputCellId: 'another-cell' } }),
      ],
    })).toEqual({ kind: 'ready' })
  })
})
