import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { VideoSplitReview } from '../../src/components/videobook/VideoSplitReview'
import {
  durationTargetsToCutPoints,
  insertSplitCutPoint,
  nudgeSplitCutPoint,
  removeSplitCutPoint,
  splitPreviewWindows,
} from '../../src/videobook/video-split-review'

describe('video split review', () => {
  it('renders two quick previews and button-based cut controls without a range input', () => {
    const html = renderToStaticMarkup(createElement(VideoSplitReview, {
      applyFormId: 'apply',
      busy: false,
      cutPointsSeconds: [4, 8],
      maxChunkCount: 10,
      mediaUrl: '/files/book/video/proxy.mp4',
      onCancel: () => undefined,
      onCutPointsChange: () => undefined,
      sourceDurationSeconds: 12,
      sourceLabel: '@a1',
    }))
    expect(html.match(/<video/g)).toHaveLength(2)
    expect(html).toContain('−0.1s')
    expect(html).toContain('+0.1s')
    expect(html).toContain('Split chunk')
    expect(html).toContain('Remove cut')
    expect(html).not.toContain('type="range"')
    expect(html).not.toContain('controls=""')
  })

  it('nudges, clamps, inserts, and removes cut points', () => {
    expect(nudgeSplitCutPoint({
      cutPointsSeconds: [1, 2],
      deltaSeconds: 1,
      index: 0,
      sourceDurationSeconds: 3,
    })).toEqual([1.5, 2])
    expect(insertSplitCutPoint({
      chunkIndex: 1,
      cutPointsSeconds: [2],
      sourceDurationSeconds: 6,
    })).toEqual([2, 4])
    expect(removeSplitCutPoint([2, 4], 0)).toEqual([4])
    expect(removeSplitCutPoint([2], 0)).toEqual([2])
  })

  it('derives duration cuts and preview windows', () => {
    expect(durationTargetsToCutPoints([3, 4.5, 2])).toEqual([3, 7.5, 9.5])
    expect(splitPreviewWindows({
      cutPointSeconds: 5,
      previousBoundarySeconds: 4,
      nextBoundarySeconds: 6,
    })).toEqual({
      before: { startSeconds: 4, endSeconds: 5 },
      after: { startSeconds: 5, endSeconds: 6 },
    })
  })
})
