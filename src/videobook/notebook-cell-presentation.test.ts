import { describe, expect, it } from 'vitest'
import {
  notebookCellInputLabelVisible,
  notebookCellRunObservation,
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
