import { describe, expect, it } from 'vitest'
import { minimumSplitPieceSeconds } from '../../src/videobook/notebook-split-command'
import {
  moveSegment,
  moveSegmentEnd,
  moveSegmentStart,
  setSegmentBounds,
  segmentOutputRanges,
  splitSegments,
} from '../../src/videobook/video-split-segments'

describe('video split segments', () => {
  it('inserts a head OUT cut and keeps the head selected', () => {
    expect(moveSegmentEnd({
      cutPointsSeconds: [],
      deltaSeconds: 0.11 - 30,
      index: 0,
      sourceDurationSeconds: 30,
    })).toEqual({
      cutPointsSeconds: [0.11],
      selectedIndex: 0,
    })
  })

  it('sets 0.03-0.11 from a midpoint cut onto the middle piece', () => {
    const edit = setSegmentBounds({
      cutPointsSeconds: [15],
      endSeconds: 0.11,
      index: 0,
      sourceDurationSeconds: 30,
      startSeconds: 0.03,
    })
    expect(edit.cutPointsSeconds).toEqual([0.03, 0.11])
    expect(edit.selectedIndex).toBe(1)
    expect(splitSegments({
      cutPointsSeconds: edit.cutPointsSeconds,
      sourceDurationSeconds: 30,
    })[1]).toMatchObject({
      startSeconds: 0.03,
      endSeconds: 0.11,
      durationSeconds: 0.08,
    })
  })

  it('moves the middle piece with constant duration until a neighbour clamp', () => {
    const moved = moveSegment({
      cutPointsSeconds: [0.03, 0.11],
      deltaSeconds: -0.02,
      index: 1,
      sourceDurationSeconds: 30,
    })
    expect(moved.cutPointsSeconds[1]! - moved.cutPointsSeconds[0]!).toBeCloseTo(0.08)
    expect(moved.cutPointsSeconds[0]).toBeGreaterThanOrEqual(minimumSplitPieceSeconds)
    const flush = moveSegment({
      cutPointsSeconds: [0.03, 0.11],
      deltaSeconds: -1,
      index: 1,
      sourceDurationSeconds: 30,
    })
    expect(flush.cutPointsSeconds[0]).toBe(minimumSplitPieceSeconds)
    expect(flush.cutPointsSeconds[1]).toBeCloseTo(minimumSplitPieceSeconds + 0.08)
    const stuck = moveSegment({
      cutPointsSeconds: flush.cutPointsSeconds,
      deltaSeconds: -1,
      index: 1,
      sourceDurationSeconds: 30,
    })
    expect(stuck.cutPointsSeconds).toEqual(flush.cutPointsSeconds)
  })

  it('compiles KEEP/REMOVE/ALL output range groups', () => {
    const cuts = { cutPointsSeconds: [0.03, 0.11], sourceDurationSeconds: 30 }
    expect(segmentOutputRanges({ ...cuts, mode: 'keep', selectedIndex: 1 })).toEqual([
      [{ startSeconds: 0.03, endSeconds: 0.11 }],
    ])
    expect(segmentOutputRanges({ ...cuts, mode: 'remove', selectedIndex: 1 })).toEqual([
      [
        { startSeconds: 0, endSeconds: 0.03 },
        { startSeconds: 0.11, endSeconds: 30 },
      ],
    ])
    expect(segmentOutputRanges({ ...cuts, mode: 'all', selectedIndex: 1 })).toEqual([
      [{ startSeconds: 0, endSeconds: 0.03 }],
      [{ startSeconds: 0.03, endSeconds: 0.11 }],
      [{ startSeconds: 0.11, endSeconds: 30 }],
    ])
  })

  it('steps IN by exactly 1/fps inside neighbour clamps', () => {
    const step = 1 / 24
    const edit = moveSegmentStart({
      cutPointsSeconds: [0.03, 0.11],
      deltaSeconds: step,
      index: 1,
      sourceDurationSeconds: 30,
    })
    expect(edit.cutPointsSeconds[0]).toBe(Math.round((0.03 + step) * 1000) / 1000)
    expect(edit.cutPointsSeconds[1]).toBe(0.11)
    const clamped = moveSegmentStart({
      cutPointsSeconds: [0.03, 0.11],
      deltaSeconds: -1,
      index: 1,
      sourceDurationSeconds: 30,
    })
    expect(clamped.cutPointsSeconds[0]).toBe(minimumSplitPieceSeconds)
    expect(clamped.cutPointsSeconds[1]).toBe(0.11)
  })
})
