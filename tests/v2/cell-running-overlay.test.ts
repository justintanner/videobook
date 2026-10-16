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
  ])('renders the active %s clock overlay', (status, label) => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'generate_image',
      address: 'a1',
      status,
      icon: createElement('span', { 'data-icon': 'img' }),
    }))

    expect(html).toContain('class="cell-state-overlay cell-state-overlay-clock"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain(`>${label}</strong>`)
    expect(html).toContain('class="cell-state-timer"')
    expect(html).toContain('class="cell-state-shimmer"')
    expect(html).not.toContain('cell-state-shimmer"><span')
    expect(html).not.toContain('cell-state-phase')
    expect(html).not.toContain('cell-state-meta')
  })

  it('names the generator and the phase while a generation runs', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'video',
      address: 'c5',
      status: 'generating',
      icon: createElement('span', { 'data-icon': 'video' }),
      generator: 'fal · bytedance/seedance-2-5',
      generation: true,
    }))

    expect(html).toContain('>GENERATING</strong>')
    expect(html).toContain('class="cell-state-meta" title="fal · bytedance/seedance-2-5"')
    expect(html).toContain('fal · bytedance/seedance-2-5</span>')
    expect(html).toContain('class="cell-state-phase-step" data-status="done"')
    expect(html).toContain('class="cell-state-phase-step" data-status="active"')
    expect(html).toContain('class="cell-state-phase-step" data-status="pending"')
    expect(html).toContain('<span>PROVIDER GENERATING</span>')
    expect(html).toContain('<span>2/3</span>')
  })

  it('moves the phase rail to the last step while the output lands', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'video',
      address: 'c5',
      status: 'downloading',
      icon: createElement('span', { 'data-icon': 'video' }),
      generation: true,
    }))

    expect(html).toContain('>DOWNLOADING</strong>')
    expect(html).toContain('class="cell-state-streaks"')
    expect(html).toContain('<span>DOWNLOAD &amp; COMMIT</span>')
    expect(html).toContain('<span>3/3</span>')
    expect(html).not.toContain('data-status="pending"')
  })

  it('keeps a plain download free of the generation rail', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'video',
      address: 'a1',
      status: 'downloading',
      icon: createElement('span', { 'data-icon': 'video' }),
    }))

    expect(html).toContain('>DOWNLOADING</strong>')
    expect(html).toContain('class="cell-state-streak"')
    expect(html).not.toContain('cell-state-phase')
  })

  it('renders a failed generation with repair and delete controls', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'generate_image',
      address: 'a1',
      status: 'error',
      statusError: 'Job lease expired',
      icon: createElement('span', { 'data-icon': 'img' }),
      generator: 'fal · bytedance/seedream-4',
      onRepair: () => undefined,
      onDelete: () => undefined,
    }))

    expect(html).toContain('class="cell-state-overlay cell-state-overlay-failed"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('GENERATION FAILED')
    expect(html).toContain('Job lease expired')
    expect(html).toContain('fal · bytedance/seedream-4</span>')
    expect(html).toContain('class="cell-state-action cell-state-repair nodrag"')
    expect(html).toContain('aria-label="Repair @a1 in chat"')
    expect(html).toContain('REPAIR')
    expect(html).toContain('class="cell-state-action cell-state-delete nodrag"')
    expect(html).toContain('aria-label="Delete @a1"')
    expect(html).toContain('DELETE')
    expect(html).not.toContain('RETRY')
  })

  it('renders a media failure with delete alone when nothing can be repaired', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'video',
      address: 'a1',
      status: 'error',
      statusError: 'Remote host returned 403',
      icon: createElement('span', { 'data-icon': 'video' }),
      onDelete: () => undefined,
    }))

    expect(html).toContain('MEDIA FAILED')
    expect(html).toContain('Remote host returned 403')
    expect(html).not.toContain('REPAIR')
    expect(html).toContain('class="cell-state-action cell-state-delete nodrag"')
  })

  it('renders nothing for an inactive cell', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'generate_image',
      address: 'a1',
      status: 'completed',
      icon: createElement('span', { 'data-icon': 'img' }),
      onRepair: () => undefined,
      onDelete: () => undefined,
    }))

    expect(html).toBe('')
  })
})
