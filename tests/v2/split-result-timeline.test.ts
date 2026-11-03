import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SplitResultTimeline } from '../../src/components/videobook/confirm/bodies/SplitResultTimeline'
import { trimSplitSelection } from '../../src/videobook/notebook-split-command'
import { splitResultTimeline } from '../../src/videobook/split-result-timeline'

describe('splitResultTimeline', () => {
  it('shows a tail trim as one removed span with no splice', () => {
    const selection = trimSplitSelection({ tailSeconds: 2 }, 12.4)
    const timeline = splitResultTimeline({
      ...selection,
      selectedIndex: selection.selectedChunkIndexes[0]!,
      sourceDurationSeconds: 12.4,
    })
    expect(timeline).toEqual({
      sourceSeconds: 12.4,
      keptSeconds: 10.4,
      removedSeconds: 2,
      kept: [{ startSeconds: 0, endSeconds: 10.4 }],
      removed: [{ startSeconds: 10.4, endSeconds: 12.4 }],
      splicePointsSeconds: [],
    })
  })

  it('marks where the remaining pieces join after a middle cut', () => {
    const timeline = splitResultTimeline({
      cutPointsSeconds: [3, 5, 8],
      outputMode: 'remove',
      selectedIndex: 1,
      sourceDurationSeconds: 10,
    })
    expect(timeline?.kept).toEqual([
      { startSeconds: 0, endSeconds: 3 },
      { startSeconds: 5, endSeconds: 10 },
    ])
    expect(timeline?.removedSeconds).toBe(2)
    expect(timeline?.keptSeconds).toBe(8)
    expect(timeline?.splicePointsSeconds).toEqual([3])
  })

  it('removes everything outside a kept piece', () => {
    const timeline = splitResultTimeline({
      cutPointsSeconds: [2, 6],
      outputMode: 'keep',
      selectedIndex: 1,
      sourceDurationSeconds: 9,
    })
    expect(timeline?.kept).toEqual([{ startSeconds: 2, endSeconds: 6 }])
    expect(timeline?.removed).toEqual([
      { startSeconds: 0, endSeconds: 2 },
      { startSeconds: 6, endSeconds: 9 },
    ])
    expect(timeline?.keptSeconds).toBe(4)
    expect(timeline?.removedSeconds).toBe(5)
  })

  it('renders before, removed and after durations with splice marks', () => {
    const timeline = splitResultTimeline({
      cutPointsSeconds: [3, 5],
      outputMode: 'remove',
      selectedIndex: 1,
      sourceDurationSeconds: 10,
    })!
    const markup = renderToStaticMarkup(createElement(SplitResultTimeline, {
      resultLabel: 'Result · new cell',
      timeline,
    }))
    expect(markup).toContain('Result · new cell')
    expect(markup).toContain('<dt>Before</dt><dd>0:10.000</dd>')
    expect(markup).toContain('<dd data-tone="removed">0:02.000</dd>')
    expect(markup).toContain('<dd data-tone="kept">0:08.000</dd>')
    expect(markup).toContain('class="confirm-split-result-splice" title="Splice at 0:03.000" style="left:30%"')
    expect(markup).toContain('class="confirm-split-result-removed" style="left:30%;width:20%"')
  })
})
