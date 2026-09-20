import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ConfirmSheet } from '@/components/videobook/confirm/ConfirmSheet'

function sheet(props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(ConfirmSheet, {
    kind: 'generation',
    ariaLabel: 'Generation action review',
    tag: 'GENERATION · CHAT',
    title: 'Animate the image at @a1.',
    address: '@a1',
    effect: { label: 'Queues 1 job · new cell', tone: 'default' },
    validation: { blocking: null, notice: null },
    busy: false,
    applyFormId: 'command-composer-form',
    onCancel: () => undefined,
    children: createElement('div', { className: 'confirm-generation' }),
    ...props,
  } as never))
}

function rule(css: string, selector: string): string {
  const openAt = css.indexOf(`${selector} {`)
  expect(openAt, selector).toBeGreaterThan(-1)
  return css.slice(openAt, css.indexOf('\n}', openAt))
}

function section(html: string, tag: 'header' | 'footer'): string {
  const open = html.indexOf(`<${tag} class="confirm-sheet-`)
  const close = html.indexOf(`</${tag}>`, open)
  expect(open, tag).toBeGreaterThan(-1)
  return html.slice(open, close)
}

describe('confirm sheet layout', () => {
  it('puts the decision, what it does and the keys that do it on one row', () => {
    // Nothing to report, so no footer: the effect chip and the shortcut hints
    // sit beside the buttons they describe instead of 44px away from them.
    const html = sheet()
    const head = section(html, 'header')
    expect(html).not.toContain('confirm-sheet-foot')
    expect(head).toContain('class="confirm-sheet-apply"')
    expect(head).toContain('Cancel <kbd>Esc</kbd>')
    expect(head).toContain('Queues 1 job · new cell')
    expect(head).toContain('confirm-sheet-head-hints')
    expect(head).toContain('<kbd>⌘↵</kbd> apply from any field')
    // Effect, then the divider and the hints, then the two buttons.
    expect(head.indexOf('confirm-sheet-effect'))
      .toBeLessThan(head.indexOf('confirm-sheet-head-hints'))
    expect(head.indexOf('confirm-sheet-head-hints'))
      .toBeLessThan(head.indexOf('confirm-sheet-actions'))
    // The submit button reaches the composer's form from outside it.
    expect(head).toContain('form="command-composer-form"')
  })

  it('hands the hints back to the footer as soon as the sheet has something to say', () => {
    const html = sheet({ validation: { blocking: 'Add a prompt', notice: null } })
    const head = section(html, 'header')
    const foot = section(html, 'footer')
    expect(head).not.toContain('confirm-sheet-head-hints')
    expect(head).not.toContain('confirm-sheet-effect')
    expect(foot).toContain('Add a prompt')
    expect(foot).toContain('Queues 1 job · new cell')
    expect(foot).not.toContain('confirm-sheet-apply')
    expect(foot).not.toContain('>Cancel ')
  })

  it('keeps optional actions out of the header so the title keeps its room', () => {
    const html = sheet({
      secondaryActions: createElement(
        'button',
        { type: 'button', className: 'confirm-sheet-secondary' },
        'Restore last edit' as ReactNode,
      ),
    })
    expect(section(html, 'header')).not.toContain('Restore last edit')
    const foot = section(html, 'footer')
    expect(foot).toContain('confirm-sheet-aside')
    expect(foot.indexOf('Restore last edit'))
      .toBeLessThan(foot.indexOf('Queues 1 job'))
  })

  it('disables Apply while a sheet is blocked and names the retry after a failure', () => {
    expect(section(sheet({ validation: { blocking: 'Add a prompt', notice: null } }), 'header'))
      .toContain('class="confirm-sheet-apply" disabled=""')
    expect(section(sheet({ busy: true, busyLabel: 'Queueing…' }), 'header'))
      .toContain('Queueing…')
  })

  it('leaves the header row room for the actions on a phone', () => {
    const css = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8')
    const phone = css.slice(
      css.indexOf('@media (max-width: 600px) {', css.indexOf('.confirm-sheet-aside')),
    )
    const block = phone.slice(0, phone.indexOf('\n}\n'))
    expect(block).toMatch(/\.confirm-sheet-head > \.section-label \{\s*display: none;/)
    expect(block).toMatch(/\.confirm-sheet-head \.confirm-sheet-actions kbd \{\s*display: none;/)
    // The trailing footer cluster wraps instead of running off the left edge.
    expect(rule(css, '.confirm-sheet-aside')).toContain('flex-wrap: wrap;')
  })
})
