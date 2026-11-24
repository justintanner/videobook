import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CellStateOverlay } from '../../src/components/videobook/cell-overlays/CellStateOverlay'
import { isGenerationCreditError } from '../../server/src/generation-credit-error'

describe('CellStateOverlay', () => {
  it.each([
    'Kie failed: Insufficient credits',
    'Out of credits',
    'No credits left',
    'Not enough credits to run this request',
    'Credit balance is too low',
    'Your credits are exhausted',
    'User is locked. Reason: Exhausted balance. Top up your balance.',
    'insufficient_quota',
    'This exceeds your remaining credits',
    'You have 10 credits left, while 100 credits are required',
  ])('offers Retry instead of Repair for %s', (statusError) => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'video', address: 'c1', status: 'error', statusError,
      icon: null, onRepair: () => undefined, onRetry: () => undefined,
      onDelete: () => undefined,
    }))
    expect(html).toContain('aria-label="Retry @c1"')
    expect(html).toContain('RETRY')
    expect(html).toContain('DELETE')
    expect(html).not.toContain('REPAIR')
  })

  it.each([
    'Rate limit exceeded. Try again later.',
    '429 Too Many Requests',
    'quota exceeded: image_urls + video_list * 2 must be <= 7',
    'reference_video_urls duration must be between 1 and 15 seconds',
    'Invalid API key',
    'Payment method verification failed',
    'Could not retrieve credit balance',
    'Provider output failed',
  ])('keeps unrelated failures out of the credit retry path: %s', (statusError) => {
    expect(isGenerationCreditError(statusError)).toBe(false)
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'video', address: 'c1', status: 'error', statusError,
      icon: null, onRepair: () => undefined, onRetry: () => undefined,
    }))
    expect(html).toContain('REPAIR')
    expect(html).not.toContain('RETRY')
  })

  it('disables Retry during a pending action', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'video', address: 'c1', status: 'error', statusError: 'Out of credits',
      icon: null, onRetry: () => undefined, disabled: true,
    }))
    expect(html).toContain('disabled=""')
  })

  it('names the Chrome retry on a sign-in-required download', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'video', address: 'a3', status: 'error', statusError: 'TikTok sign-in required.',
      icon: null, downloadRetry: 'chrome', onRetry: () => undefined,
    }))
    expect(html).toContain('DOWNLOAD FAILED')
    expect(html).toContain('aria-label="Retry @a3 with Chrome"')
    expect(html).toContain('USE CHROME')
  })

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
    expect(html).toContain(`aria-label="@a1 ${label.toLowerCase()}"`)
    expect(html).not.toContain('<strong>')
    expect(html).toContain('class="cell-state-timer"')
    expect(html).toContain('class="cell-state-shimmer"')
    expect(html).not.toContain('cell-state-shimmer"><span')
    expect(html).not.toContain('cell-state-phase')
  })

  it('names the phase while a generation runs and leaves the generator to the source chip', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'video',
      address: 'c5',
      status: 'generating',
      icon: createElement('span', { 'data-icon': 'video' }),
      generation: true,
    }))

    expect(html).toContain('aria-label="@c5 generating"')
    expect(html).not.toContain('cell-generator-provider')
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

    expect(html).toContain('aria-label="@c5 downloading"')
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

    expect(html).toContain('aria-label="@a1 downloading"')
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
      onRepair: () => undefined,
      onDelete: () => undefined,
    }))

    expect(html).toContain('class="cell-state-overlay cell-state-overlay-failed"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('GENERATION FAILED')
    expect(html).toContain('Job lease expired')
    expect(html).toContain('class="cell-state-action cell-state-repair nodrag"')
    expect(html).toContain('aria-label="Repair @a1 in chat"')
    expect(html).toContain('REPAIR')
    expect(html).toContain('class="cell-state-action cell-state-delete nodrag"')
    expect(html).toContain('aria-label="Delete @a1"')
    expect(html).toContain('DELETE')
    expect(html).not.toContain('RETRY')
  })

  it('names a failed take a generation failure, not a media one', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'video',
      address: 'f3',
      status: 'error',
      statusError: 'Provider output failed',
      icon: null,
      generation: true,
      onRepair: () => undefined,
    }))

    expect(html).toContain('<strong>GENERATION FAILED</strong>')
    expect(html).not.toContain('MEDIA FAILED')
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

  it('docks a generation clock under the prompt instead of covering it', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'generate_audio',
      address: 'b8',
      status: 'generating',
      icon: null,
      generation: true,
      docked: true,
    }))

    expect(html).toContain('class="cell-state-dock cell-state-dock-clock"')
    expect(html).toContain('aria-label="@b8 generating"')
    expect(html).toContain('class="cell-state-phase-step" data-status="active"')
    expect(html).toContain('<span class="cell-state-dock-label">PROVIDER GENERATING</span>')
    expect(html).not.toContain('cell-state-overlay')
  })

  it('holds the docked bar still while a generation waits for a slot', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'generate_audio',
      address: 'b8',
      status: 'queued',
      icon: null,
      generation: true,
      docked: true,
    }))

    expect(html).toContain('class="cell-state-dock cell-state-dock-clock cell-state-dock-waiting"')
    expect(html).toContain('<span class="cell-state-dock-label">QUEUED</span>')
  })

  it('docks a failed generation with its repair and delete controls', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'generate_video',
      address: 'b6',
      status: 'error',
      statusError: 'Kie only offers 5s or 10s here.',
      icon: null,
      generation: true,
      docked: true,
      onRepair: () => undefined,
      onDelete: () => undefined,
    }))

    expect(html).toContain('class="cell-state-dock cell-state-dock-failed"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('<strong>GENERATION FAILED</strong>')
    expect(html).toContain('Kie only offers 5s or 10s here.')
    expect(html).toContain('REPAIR')
    expect(html).toContain('DELETE')
    expect(html).not.toContain('cell-state-scanlines')
  })

  it('lightens the clock over a picture that is being edited', () => {
    const html = renderToStaticMarkup(createElement(CellStateOverlay, {
      kind: 'video',
      address: 'd3',
      status: 'trimming',
      icon: null,
      overPicture: true,
    }))

    expect(html).toContain('class="cell-state-overlay cell-state-overlay-clock cell-state-overlay-over-picture"')
    expect(html).toContain('aria-label="@d3 trimming"')
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
