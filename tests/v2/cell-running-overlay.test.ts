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
      address: 'a1',
      status,
      icon: createElement('span', { 'data-icon': 'img' }),
      onRetry: () => undefined,
    }))

    expect(html).toContain('class="cell-state-overlay cell-state-overlay-clock"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain(`>${label}</strong>`)
    expect(html).toContain('class="cell-state-timer"')
    expect(html).toContain('class="cell-state-shimmer"')
    expect(html).not.toContain('cell-state-shimmer"><span')
  })

  it('renders a failed overlay with error text and retry control', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'generate_image',
      address: 'a1',
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

  it('renders a streaming download animation', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'video',
      address: 'a1',
      status: 'downloading',
      icon: createElement('span', { 'data-icon': 'video' }),
    }))

    expect(html).toContain('>DOWNLOADING</strong>')
    expect(html).toContain('class="cell-state-streaks"')
    expect(html).toContain('class="cell-state-streak"')
  })

  it('renders a passive media failure without generation retry', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'video',
      address: 'a1',
      status: 'error',
      statusError: 'Remote host returned 403',
      icon: createElement('span', { 'data-icon': 'video' }),
    }))

    expect(html).toContain('MEDIA FAILED')
    expect(html).toContain('Remote host returned 403')
    expect(html).not.toContain('RETRY')
  })

  it('renders nothing for an inactive cell', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'generate_image',
      address: 'a1',
      status: 'completed',
      icon: createElement('span', { 'data-icon': 'img' }),
      onRetry: () => undefined,
    }))

    expect(html).toBe('')
  })
})
