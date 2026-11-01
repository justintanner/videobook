import { describe, expect, it } from 'vitest'
import type { SceneData } from '../../server/src/scene-cuts'
import {
  cutKey,
  cutReviewRows,
  nextPendingCut,
  previousCut,
  reviewProgress,
  weakerCandidates,
} from './cut-review'

const SCENES: SceneData = {
  assetId: 'vid',
  durationSeconds: 30,
  fps: 30,
  cuts: [
    { t: 4.7, score: 24.8 },
    { t: 8.15, score: 11.5 },
    { t: 9.6, score: 4.2 },
    { t: 25.3, score: 4.3 },
  ],
  settles: [],
  filmstrip: null,
}

describe('cut review', () => {
  const rows = cutReviewRows({
    cutPointsSeconds: [4.7, 8.15, 12],
    frameStep: 1 / 30,
    removedSeconds: [9.6],
    reviewedKeys: new Set([cutKey(4.7)]),
    scenes: SCENES,
  })

  it('lists active and removed cuts in time order with their status and score', () => {
    expect(rows).toEqual([
      { t: 4.7, score: 24.8, status: 'kept' },
      { t: 8.15, score: 11.5, status: 'pending' },
      { t: 9.6, score: 4.2, status: 'removed' },
      { t: 12, score: null, status: 'pending' },
    ])
    expect(reviewProgress(rows)).toEqual({ done: 2, total: 4 })
  })

  it('steps to the next pending cut, wrapping to the first', () => {
    expect(nextPendingCut(rows, 8.15)).toBe(12)
    expect(nextPendingCut(rows, 12)).toBe(8.15)
    expect(previousCut(rows, 12)).toBe(8.15)
    expect(previousCut(rows, 4.7)).toBeNull()
  })

  it('offers detected cuts that are neither active nor removed', () => {
    expect(weakerCandidates({
      cutPointsSeconds: [4.7, 8.15],
      frameStep: 1 / 30,
      removedSeconds: [9.6],
      scenes: SCENES,
    })).toEqual([{ t: 25.3, score: 4.3 }])
  })
})
