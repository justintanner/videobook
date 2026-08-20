import { describe, expect, it } from 'vitest'
import { nextSegmentLoopAction } from '../../src/videobook/segment-loop-playback'

describe('segment loop playback', () => {
  it('wraps a 0.08s window at most one frame past the end', () => {
    const windows = [{ startSeconds: 0.03, endSeconds: 0.11 }]
    const frame = 1 / 24
    expect(nextSegmentLoopAction({
      activeWindowIndex: 0,
      currentTimeSeconds: 0.03,
      frameDurationSeconds: frame,
      windows,
    })).toEqual({ type: 'continue' })
    expect(nextSegmentLoopAction({
      activeWindowIndex: 0,
      currentTimeSeconds: 0.109,
      frameDurationSeconds: frame,
      windows,
    })).toEqual({ type: 'continue' })
    expect(nextSegmentLoopAction({
      activeWindowIndex: 0,
      currentTimeSeconds: 0.11,
      frameDurationSeconds: frame,
      windows,
    })).toEqual({ type: 'seek', timeSeconds: 0.03, windowIndex: 0 })
    expect(nextSegmentLoopAction({
      activeWindowIndex: 0,
      currentTimeSeconds: 0.11 + frame,
      frameDurationSeconds: frame,
      windows,
    })).toEqual({ type: 'seek', timeSeconds: 0.03, windowIndex: 0 })
  })

  it('seeks from in to out once per join loop and skips the removed span', () => {
    const windows = [
      { startSeconds: 0, endSeconds: 0.03 },
      { startSeconds: 0.11, endSeconds: 1.61 },
    ]
    const frame = 1 / 24
    expect(nextSegmentLoopAction({
      activeWindowIndex: 0,
      currentTimeSeconds: 0.03,
      frameDurationSeconds: frame,
      windows,
    })).toEqual({ type: 'seek', timeSeconds: 0.11, windowIndex: 1 })
    expect(nextSegmentLoopAction({
      activeWindowIndex: 1,
      currentTimeSeconds: 0.11,
      frameDurationSeconds: frame,
      windows,
    })).toEqual({ type: 'continue' })
    expect(nextSegmentLoopAction({
      activeWindowIndex: 1,
      currentTimeSeconds: 1.61,
      frameDurationSeconds: frame,
      windows,
    })).toEqual({ type: 'seek', timeSeconds: 0, windowIndex: 0 })
    const inRemoved = nextSegmentLoopAction({
      activeWindowIndex: 0,
      currentTimeSeconds: 0.07,
      frameDurationSeconds: frame,
      windows,
    })
    expect(inRemoved).toEqual({ type: 'seek', timeSeconds: 0.11, windowIndex: 1 })
    expect(nextSegmentLoopAction({
      activeWindowIndex: 0,
      currentTimeSeconds: 0.03,
      frameDurationSeconds: frame,
      pendingSeekSeconds: 0.11,
      windows,
    })).toEqual({ type: 'continue' })
  })
})
