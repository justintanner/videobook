import { describe, expect, it } from 'vitest'
import type { NotebookDocument } from 'videobook-engine'
import { notebookCellRunObservation } from './notebook-cell-presentation'
import {
  notebookGenerationInterruptedMessage,
  notebookRunWatchStep,
  selectEffectiveNotebookRunJob,
  type NotebookRunJobView,
} from './notebook-run-watch'

const cellId = '018f7cf5-0d31-7d96-8c0f-800000000002'
const runId = '018f7cf5-0d31-7d96-8c0f-800000000099'
const otherRunId = '018f7cf5-0d31-7d96-8c0f-800000000098'

function documentWithExecution(
  execution: NotebookDocument['execution'],
): Pick<NotebookDocument, 'execution'> {
  return { execution }
}

function observation(
  execution: NonNullable<NotebookDocument['execution']>,
  targetRunId = runId,
) {
  return notebookCellRunObservation(
    documentWithExecution(execution),
    cellId,
    targetRunId,
  )
}

function job(partial: Partial<NotebookRunJobView> & Pick<NotebookRunJobView, 'state'>): NotebookRunJobView {
  return {
    errorMessage: null,
    operationId: '018f7cf5-0d31-7d96-8c0f-800000000010',
    type: 'run_notebook',
    payload: null,
    ...partial,
  }
}

describe('notebookRunWatchStep', () => {
  it('fails on observation error, with or without error text', () => {
    const withText = notebookRunWatchStep({
      observation: observation({
        [cellId]: { status: 'error', error: 'provider died', runId },
      }),
      job: null,
      address: 'scene-a',
      sawRun: true,
    })
    expect(withText).toEqual({ kind: 'failed', message: 'provider died' })

    const withoutText = notebookRunWatchStep({
      observation: observation({
        [cellId]: { status: 'error', runId },
      }),
      job: null,
      address: 'scene-a',
      sawRun: true,
    })
    expect(withoutText).toEqual({ kind: 'failed', message: '@scene-a failed' })
  })

  it('completes when observation is completed', () => {
    expect(notebookRunWatchStep({
      observation: observation({
        [cellId]: { status: 'completed', runId },
      }),
      job: job({ state: 'running' }),
      address: 'scene-a',
      sawRun: true,
    })).toEqual({ kind: 'completed' })
  })

  it('sets sawRun when observation is active', () => {
    expect(notebookRunWatchStep({
      observation: observation({
        [cellId]: { status: 'awaiting-output', runId },
      }),
      job: job({ state: 'running' }),
      address: 'scene-a',
      sawRun: false,
    })).toEqual({ kind: 'continue', sawRun: true })
  })

  it('supersedes when runId mismatches after the watcher has seen its run', () => {
    expect(notebookRunWatchStep({
      observation: observation({
        [cellId]: { status: 'running', runId: otherRunId },
      }),
      job: null,
      address: 'scene-a',
      sawRun: true,
    })).toEqual({ kind: 'superseded' })
  })

  it('fails on job failure with clear-slot hint when observation is not matching', () => {
    const step = notebookRunWatchStep({
      observation: observation({
        [cellId]: { status: 'running', runId: otherRunId },
      }),
      job: job({
        state: 'failed',
        errorMessage: 'Job lease expired',
      }),
      address: 'scene-a',
      sawRun: false,
    })
    expect(step.kind).toBe('failed')
    if (step.kind !== 'failed') return
    expect(step.message).toContain('Job lease expired')
    expect(step.message).toContain('Clear the slot')
  })

  it('continues when observation is pending before any active sighting and job is healthy', () => {
    expect(notebookRunWatchStep({
      observation: observation({}),
      job: job({ state: 'running' }),
      address: 'scene-a',
      sawRun: false,
    })).toEqual({ kind: 'continue', sawRun: false })
  })

  it('prefers observation error over a failed job', () => {
    expect(notebookRunWatchStep({
      observation: observation({
        [cellId]: { status: 'error', error: 'cell error text', runId },
      }),
      job: job({ state: 'failed', errorMessage: 'job error' }),
      address: 'scene-a',
      sawRun: true,
    })).toEqual({ kind: 'failed', message: 'cell error text' })
  })
})

describe('selectEffectiveNotebookRunJob', () => {
  it('picks the newest failed await over a done run_notebook job', () => {
    const selected = selectEffectiveNotebookRunJob({
      cellId,
      runId,
      jobOperationId: '018f7cf5-0d31-7d96-8c0f-800000000001',
      jobs: [
        job({
          operationId: '018f7cf5-0d31-7d96-8c0f-800000000001',
          type: 'run_notebook',
          state: 'done',
        }),
        job({
          operationId: '018f7cf5-0d31-7d96-8c0f-800000000020',
          type: 'await_notebook_output',
          state: 'failed',
          errorMessage: 'Job lease expired',
          payload: { cellId, runId },
        }),
        job({
          operationId: '018f7cf5-0d31-7d96-8c0f-800000000030',
          type: 'await_notebook_output',
          state: 'failed',
          errorMessage: 'newer failure',
          payload: { cellId, runId },
        }),
      ],
    })
    expect(selected?.operationId).toBe('018f7cf5-0d31-7d96-8c0f-800000000030')
    expect(selected?.errorMessage).toBe('newer failure')
  })

  it('prefers a running await over an older failed await', () => {
    const selected = selectEffectiveNotebookRunJob({
      cellId,
      runId,
      jobOperationId: '018f7cf5-0d31-7d96-8c0f-800000000001',
      jobs: [
        job({
          operationId: '018f7cf5-0d31-7d96-8c0f-800000000020',
          type: 'await_notebook_output',
          state: 'failed',
          errorMessage: 'old',
          payload: { cellId, runId },
        }),
        job({
          operationId: '018f7cf5-0d31-7d96-8c0f-800000000040',
          type: 'await_notebook_output',
          state: 'running',
          payload: { cellId, runId },
        }),
      ],
    })
    expect(selected?.state).toBe('running')
    expect(selected?.operationId).toBe('018f7cf5-0d31-7d96-8c0f-800000000040')
  })

  it('falls back to the run job by operationId when no awaits match', () => {
    const selected = selectEffectiveNotebookRunJob({
      cellId,
      runId,
      jobOperationId: '018f7cf5-0d31-7d96-8c0f-800000000001',
      jobs: [
        job({
          operationId: '018f7cf5-0d31-7d96-8c0f-800000000001',
          type: 'run_notebook',
          state: 'running',
        }),
        job({
          operationId: '018f7cf5-0d31-7d96-8c0f-800000000099',
          type: 'await_notebook_output',
          state: 'failed',
          payload: { cellId: 'other', runId },
        }),
      ],
    })
    expect(selected?.type).toBe('run_notebook')
    expect(selected?.operationId).toBe('018f7cf5-0d31-7d96-8c0f-800000000001')
  })
})

describe('notebookGenerationInterruptedMessage', () => {
  it('includes the clear-slot hint', () => {
    expect(notebookGenerationInterruptedMessage('Job lease expired', 'failed'))
      .toContain('Clear the slot to reset the cell')
  })
})
