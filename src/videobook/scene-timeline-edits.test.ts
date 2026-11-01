import { describe, expect, it } from 'vitest'
import {
  addSceneCut,
  filmstripTileFrames,
  moveSceneCut,
  removeSceneCut,
  snapToFrame,
} from './scene-timeline-edits'

describe('scene timeline edits', () => {
  it('snaps times to whole frames', () => {
    expect(snapToFrame(1.01, 1 / 24)).toBe(1)
    expect(snapToFrame(1.0234, null)).toBe(1.023)
  })

  it('adds a cut in order and selects the piece it starts', () => {
    expect(addSceneCut({ cutPointsSeconds: [2, 6], seconds: 4, sourceDurationSeconds: 10 }))
      .toEqual({ cutPointsSeconds: [2, 4, 6], selectedIndex: 2 })
    expect(addSceneCut({ cutPointsSeconds: [2], seconds: 2.01, sourceDurationSeconds: 10 })).toBeNull()
    expect(addSceneCut({ cutPointsSeconds: [], seconds: 9.995, sourceDurationSeconds: 10 })).toBeNull()
  })

  it('moves a cut but never past its neighbours', () => {
    expect(moveSceneCut({ cutPointsSeconds: [2, 4], index: 0, seconds: 9, sourceDurationSeconds: 10 }))
      .toEqual({ cutPointsSeconds: [3.98, 4], selectedIndex: 1 })
    expect(moveSceneCut({ cutPointsSeconds: [2, 4], index: 1, seconds: 4.5, sourceDurationSeconds: 10 }))
      .toEqual({ cutPointsSeconds: [2, 4.5], selectedIndex: 2 })
  })

  it('removes a cut', () => {
    expect(removeSceneCut({ cutPointsSeconds: [2, 4, 6], index: 1 }))
      .toEqual({ cutPointsSeconds: [2, 6], selectedIndex: 1 })
  })

  it('samples filmstrip frames evenly across visible tiles', () => {
    expect(filmstripTileFrames({ frames: 12, tiles: 4 })).toEqual([1, 4, 7, 10])
    expect(filmstripTileFrames({ frames: 3, tiles: 6 })).toEqual([0, 0, 1, 1, 2, 2])
  })
})
