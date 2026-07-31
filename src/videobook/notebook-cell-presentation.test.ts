import { describe, expect, it } from 'vitest'
import {
  notebookCellClockLabel,
  notebookCellInputLabelVisible,
  notebookCellRunObservation,
  notebookCellStateFromStatus,
  notebookCellStatePresentation,
} from './notebook-cell-presentation'

describe('notebookCellInputLabelVisible', () => {
  it('hides the default generation input label', () => {
    expect(notebookCellInputLabelVisible('input')).toBe(false)
  })

  it('keeps meaningful multi-input labels', () => {
    expect(notebookCellInputLabelVisible('video')).toBe(true)
    expect(notebookCellInputLabelVisible('input_2')).toBe(true)
    expect(notebookCellInputLabelVisible('result')).toBe(true)
    expect(notebookCellInputLabelVisible('analysis')).toBe(true)
    expect(notebookCellInputLabelVisible('media')).toBe(true)
    expect(notebookCellInputLabelVisible('segment')).toBe(true)
  })
})

describe('notebookCellRunObservation', () => {
  const cellId = '018f7cf5-0d31-7d96-8c0f-800000000002'
  const runId = '018f7cf5-0d31-7d96-8c0f-800000000099'

  it('returns pending when the run is not yet written', () => {
    expect(notebookCellRunObservation({ execution: {} }, cellId, runId))
      .toEqual({ error: null, state: 'pending', status: null })
  })

  it('returns active for awaiting-output on the matching run', () => {
    expect(notebookCellRunObservation({
      execution: {
        [cellId]: { status: 'awaiting-output', runId },
      },
    }, cellId, runId)).toEqual({
      error: null,
      state: 'active',
      status: 'awaiting-output',
    })
  })

  it('returns completed for a finished matching run', () => {
    expect(notebookCellRunObservation({
      execution: {
        [cellId]: { status: 'completed', runId },
      },
    }, cellId, runId)).toEqual({
      error: null,
      state: 'completed',
      status: 'completed',
    })
  })
})

describe('notebookCellClockLabel', () => {
  it('maps queued/completing/awaiting-output to fixed labels', () => {
    expect(notebookCellClockLabel('queued', 'generate_image')).toBe('QUEUED')
    expect(notebookCellClockLabel('completing', 'generate_image')).toBe('FINISHING')
    expect(notebookCellClockLabel('awaiting-output', 'generate_image')).toBe('GENERATING')
  })

  it('maps running labels by cell kind', () => {
    expect(notebookCellClockLabel('running', 'generate_video')).toBe('GENERATING')
    expect(notebookCellClockLabel('running', 'analyze')).toBe('ANALYZING')
    expect(notebookCellClockLabel('running', 'extract_frame')).toBe('EXTRACTING')
    expect(notebookCellClockLabel('running', 'split_video')).toBe('SPLITTING')
    expect(notebookCellClockLabel('running', 'splice')).toBe('SPLICING')
    expect(notebookCellClockLabel('running', 'concat')).toBe('CONCATENATING')
    expect(notebookCellClockLabel('running', 'prompt')).toBe('REWRITING')
  })
})

describe('notebookCellStateFromStatus', () => {
  it('returns null overlay for ready/completed/stale', () => {
    for (const status of ['ready', 'completed', 'stale'] as const) {
      expect(notebookCellStateFromStatus('generate_image', status)).toEqual({
        overlay: null,
        label: null,
        startedAt: null,
        error: null,
        tone: null,
      })
    }
  })

  it('returns clock overlay for active statuses with timer start', () => {
    const startedAt = Date.parse('2026-07-31T12:00:00.000Z')
    expect(notebookCellStateFromStatus('generate_image', 'running', {
      startedAt: '2026-07-31T12:00:00.000Z',
    })).toEqual({
      overlay: 'clock',
      label: 'GENERATING',
      startedAt,
      error: null,
      tone: 'active',
    })
    expect(notebookCellStateFromStatus('generate_image', 'queued')).toMatchObject({
      overlay: 'clock',
      label: 'QUEUED',
      tone: 'queued',
    })
    expect(notebookCellStateFromStatus('analyze', 'awaiting-output')).toMatchObject({
      overlay: 'clock',
      label: 'GENERATING',
      tone: 'active',
    })
    expect(notebookCellStateFromStatus('prompt', 'completing')).toMatchObject({
      overlay: 'clock',
      label: 'FINISHING',
    })
  })

  it('returns failed overlay with error message and retry path data', () => {
    expect(notebookCellStateFromStatus('generate_image', 'error', {
      error: 'Job lease expired',
    })).toEqual({
      overlay: 'failed',
      label: null,
      startedAt: null,
      error: 'Job lease expired',
      tone: 'error',
    })
    expect(notebookCellStateFromStatus('generate_image', 'running', {
      error: 'live failure',
    })).toMatchObject({
      overlay: 'failed',
      error: 'live failure',
      tone: 'error',
    })
  })
})

describe('notebookCellStatePresentation', () => {
  const cellId = '018f7cf5-0d31-7d96-8c0f-800000000010'

  it('reads execution startedAt and error from the document', () => {
    expect(notebookCellStatePresentation({
      execution: {
        [cellId]: {
          status: 'awaiting-output',
          startedAt: '2026-07-31T10:00:00.000Z',
        },
      },
    }, cellId, 'generate_image')).toEqual({
      overlay: 'clock',
      label: 'GENERATING',
      startedAt: Date.parse('2026-07-31T10:00:00.000Z'),
      error: null,
      tone: 'active',
    })

    expect(notebookCellStatePresentation({
      execution: {
        [cellId]: {
          status: 'error',
          error: 'Provider output timed out',
        },
      },
    }, cellId, 'generate_image')).toEqual({
      overlay: 'failed',
      label: null,
      startedAt: null,
      error: 'Provider output timed out',
      tone: 'error',
    })
  })

  it('prefers live error overrides over document execution', () => {
    expect(notebookCellStatePresentation({
      execution: {
        [cellId]: { status: 'running' },
      },
    }, cellId, 'generate_image', {
      error: 'client-side failure',
    })).toMatchObject({
      overlay: 'failed',
      error: 'client-side failure',
    })
  })
})
