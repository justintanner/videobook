import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CellStateOverlay } from '../../src/components/videobook/cell-overlays/CellStateOverlay'

describe('CellStateOverlay', () => {
  it.each([
    ['queued', 'QUEUED'],
    ['running', 'GENERATING'],
    ['completing', 'FINISHING'],
    ['awaiting-output', 'GENERATING'],
  ])('renders the active %s clock overlay across the card shell', (status, label) => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'generate_image',
      slug: 'generate-image-01',
      status,
      icon: createElement('span', { 'data-icon': 'img' }),
      onRetry: () => undefined,
    }))

    expect(html).toContain('class="cell-state-overlay cell-state-overlay-clock"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain(`>${label}</strong>`)
    expect(html).toContain('class="cell-state-timer"')
    expect(html).toContain('class="cell-state-particles"')
  })

  it('renders a failed overlay with error text and retry control', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'generate_image',
      slug: 'generate-image-01',
      status: 'error',
      statusError: 'Job lease expired',
      icon: createElement('span', { 'data-icon': 'img' }),
      onRetry: () => undefined,
    }))

    expect(html).toContain('class="cell-state-overlay cell-state-overlay-failed"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('GENERATION FAILED')
    expect(html).toContain('Job lease expired')
    expect(html).toContain('RETRY')
    expect(html).toContain('class="cell-state-retry nodrag"')
  })

  it('renders nothing for an inactive cell', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'generate_image',
      slug: 'generate-image-01',
      status: 'completed',
      icon: createElement('span', { 'data-icon': 'img' }),
      onRetry: () => undefined,
    }))

    expect(html).toBe('')
  })
})
