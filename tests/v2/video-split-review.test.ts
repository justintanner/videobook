import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { VideoSegmentSplit } from '../../src/components/videobook/VideoSegmentSplit'
import { writeFileSync } from 'node:fs'
const DRAWER_DUMP = process.env.VIDEO_SEGMENT_SPLIT_HTML_PATH

describe('video segment split', () => {
  it('renders a buttons-only editor with KEEP/REMOVE/ALL and two loop tiles', () => {
    const html = renderToStaticMarkup(createElement(VideoSegmentSplit, {
      applyFormId: 'apply',
      availableEmptyCells: 8,
      busy: false,
      cutPointsSeconds: [0.03, 0.11],
      mediaUrl: '/files/book/video/proxy.mp4',
      onCancel: () => undefined,
      onChange: () => undefined,
      outputMode: 'keep',
      selectedIndex: 1,
      sourceDurationSeconds: 30,
      sourceFps: 24,
      sourceLabel: '@a1',
    }))
    if (DRAWER_DUMP) writeFileSync(DRAWER_DUMP, html)
    expect(html.match(/<video/g)).toHaveLength(3)
    expect(html).toContain('KEEP segment')
    expect(html).toContain('REMOVE segment')
    expect(html).toContain('ALL pieces')
    expect(html).toContain('+0.01s')
    expect(html).toContain('−0.01s')
    expect(html).toContain('SET IN HERE')
    expect(html).toContain('SET OUT HERE')
    expect(html).toContain('PREV FRAME')
    expect(html).toContain('NEXT FRAME')
    expect(html).toContain('Slow x0.25')
    expect(html).not.toContain('type="range"')
    expect(html).toContain('controls')
    expect(html).toContain('0:00.030')
    expect(html).toContain('0:00.110')
  })

  it('hides frame steps when fps is unknown', () => {
    const html = renderToStaticMarkup(createElement(VideoSegmentSplit, {
      applyFormId: 'apply',
      availableEmptyCells: 8,
      busy: false,
      cutPointsSeconds: [15],
      mediaUrl: '/files/book/video/proxy.mp4',
      onCancel: () => undefined,
      onChange: () => undefined,
      outputMode: 'all',
      selectedIndex: 0,
      sourceDurationSeconds: 30,
      sourceFps: null,
      sourceLabel: '@a1',
    }))
    expect(html).not.toContain('PREV FRAME')
    expect(html).not.toContain('NEXT FRAME')
    expect(html).not.toContain('type="range"')
  })
})
