import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CellRunningOverlay } from '../../src/components/videobook/CellRunningOverlay'

describe('CellRunningOverlay', () => {
  it.each([
    ['queued', 'Queued'],
    ['running', 'Running'],
    ['completing', 'Finishing'],
    ['awaiting-output', 'Awaiting output'],
  ])('renders the active %s state across the card shell', (status, label) => {
    const html = renderToStaticMarkup(createElement(CellRunningOverlay, {
      slug: 'extract-audio-source',
      status,
    }))

    expect(html).toContain('class="cell-running-overlay"')
    expect(html).toContain(`data-running-status="${status}"`)
    expect(html).toContain(`>${label}</strong>`)
    expect(html).toContain('role="status"')
  })

  it('renders nothing for an inactive cell', () => {
    const html = renderToStaticMarkup(createElement(CellRunningOverlay, {
      slug: 'extract-audio-source',
      status: 'completed',
    }))

    expect(html).toBe('')
  })
})
