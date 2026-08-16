import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { notebookGrid } from '../../src/videobook/notebook-grid'

const css = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8')

function braceBlock(source: string, openAt: number): string {
  const bodyStart = source.indexOf('{', openAt)
  if (bodyStart < 0) {
    throw new Error('missing opening brace')
  }
  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return source.slice(bodyStart + 1, index)
    }
  }
  throw new Error('unclosed block')
}

function rule(source: string, selector: string): string {
  const needle = `${selector} {`
  const openAt = source.indexOf(needle)
  if (openAt < 0) {
    throw new Error(`missing rule ${selector}`)
  }
  return braceBlock(source, openAt)
}

function declaration(block: string, property: string): string {
  const match = block.match(new RegExp(`(?:^|\\n)\\s*${property}:\\s*([^;]+);`))
  if (!match?.[1]) {
    throw new Error(`missing ${property}`)
  }
  return match[1].trim()
}

function pixelCount(value: string): number {
  const match = value.match(/^(-?\d+(?:\.\d+)?)px$/)
  if (!match?.[1]) {
    throw new Error(`not a px value: ${value}`)
  }
  return Number(match[1])
}

describe('notebook chrome tokens', () => {
  it('keeps grid origins at zero so the chrome inset owns the gutter', () => {
    const shell = rule(css, '.app-shell')
    const gutter = declaration(shell, '--app-gutter')
    expect(gutter).toBe(`calc(var(--app-gap) * 2)`)
    expect(notebookGrid.originX).toBe(0)
    expect(notebookGrid.originY).toBe(0)
    expect(pixelCount(declaration(shell, '--app-gap'))).toBe(10)
  })

  it('routes header, composer, and canvas chrome through the gutter token', () => {
    expect(declaration(rule(css, '.brand-project-home'), 'padding'))
      .toContain('var(--app-gutter)')
    expect(declaration(rule(css, '.header-navigation'), 'margin-right'))
      .toBe('var(--app-gutter)')
    const composer = rule(css, '.command-composer')
    expect(declaration(composer, 'left')).toBe('var(--app-gutter)')
    expect(declaration(composer, 'right')).toBe('var(--app-gutter)')
    expect(declaration(composer, 'bottom')).toBe('var(--app-gutter)')
    const canvas = rule(css, '.canvas')
    expect(declaration(canvas, '--notebook-chrome-inset')).toBe('var(--app-gutter)')
    expect(declaration(canvas, '--notebook-composer-clearance'))
      .toBe('calc(var(--app-gutter) + 56px + var(--app-gap))')
    expect(rule(css, '.notebook-flow-frame')).not.toContain('margin-top')
  })

  it('aligns the scroll container and both scrollbars on the chrome inset', () => {
    const scroll = rule(css, '.notebook-horizontal-scroll')
    expect(declaration(scroll, 'margin'))
      .toBe('var(--notebook-chrome-inset) var(--notebook-chrome-inset) 0')
    expect(declaration(scroll, 'height'))
      .toBe('calc(100% - var(--notebook-chrome-inset))')
    expect(declaration(scroll, 'scrollbar-gutter')).toBe('stable')
    expect(declaration(scroll, 'scrollbar-width')).toBe('auto')
    expect(declaration(scroll, 'scrollbar-color')).toBe('auto')
    const bar = rule(css, '.notebook-horizontal-scroll::-webkit-scrollbar')
    expect(declaration(bar, 'width')).toBe('var(--notebook-scrollbar-size)')
    expect(declaration(bar, 'height')).toBe('var(--notebook-scrollbar-size)')
    expect(declaration(rule(css, '.canvas'), '--notebook-scrollbar-size'))
      .toBe('10px')
  })

  it('keeps the inspector reopen control clear of the scrollbar lane', () => {
    const reopen = rule(css, '.inspector-reopen')
    expect(declaration(reopen, 'width')).toBe('40px')
    expect(declaration(reopen, 'height')).toBe('40px')
    expect(declaration(reopen, 'right')).toBe(
      'calc(var(--notebook-chrome-inset) + var(--notebook-scrollbar-size) + var(--app-gap))',
    )
  })

  it('keeps generation review actions outside the scrollable editor', () => {
    const review = rule(css, '.generation-chat-review')
    expect(declaration(review, 'display')).toBe('grid')
    expect(declaration(review, 'grid-template-rows')).toBe('auto minmax(0, 1fr)')
    expect(declaration(review, 'overflow')).toBe('hidden')
    const editor = rule(css, '.generation-review-editor')
    expect(declaration(editor, 'min-height')).toBe('0')
    expect(declaration(editor, 'overflow')).toBe('auto')
  })

  it('drops the UA outline on the notebook canvas without a global * focus wipe', () => {
    expect(css).not.toMatch(/\*\s*(?:,[^{]+)?\{[^}]*outline:\s*none/)
    const focusRule = [...css.matchAll(
      /([^{}]+?)\s*\{([^{}]*outline:\s*none[^{}]*)\}/g,
    )].find((match) => match[1]?.includes('.notebook-horizontal-scroll:focus'))
    expect(focusRule?.[1]).toContain('.moment-grid:focus')
    expect(focusRule?.[1]).toContain('.analysis-cell-output-json-scroll:focus')
    expect(focusRule?.[1]).toContain('.inspector-analysis-json-scroll:focus')
    expect(declaration(focusRule?.[2] ?? '', 'outline')).toBe('none')
    const controlFocus = rule(css, 'textarea:focus-visible')
    expect(declaration(controlFocus, 'outline')).toBe('1px solid var(--green)')
  })

  it('overrides only the gutter token at the 720px breakpoint', () => {
    const queryAt = css.indexOf('@media (max-width: 720px) {')
    expect(queryAt).toBeGreaterThan(-1)
    const mobile = braceBlock(css, queryAt)
    const mobileGap = declaration(rule(css, '.app-shell'), '--app-gap')
    expect(declaration(rule(mobile, '.app-shell'), '--app-gutter')).toBe(mobileGap)
  })
})
