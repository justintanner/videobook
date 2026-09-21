import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { notebookGrid } from '../../src/videobook/notebook-grid'

const css = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8')
const musicCss = readFileSync(new URL('../../src/components/videobook/MusicVideoEditor.css', import.meta.url), 'utf8')
const fullscreen = readFileSync(new URL('../../src/components/videobook/NotebookMediaFullscreen.tsx', import.meta.url), 'utf8')

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
    expect(pixelCount(gutter)).toBe(28)
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
      .toBe('calc(var(--app-gutter) + var(--notebook-command-row-height, 58px) + var(--app-gap) + 16px)')
    expect(declaration(canvas, '--notebook-chrome-top')).toBe('20px')
    expect(rule(css, '.notebook-flow-frame')).not.toContain('margin-top')
    // The clearance is the scroll container's bottom padding, not the
    // canvas's: the canvas reserving it would clip the grid at a hard edge
    // instead of letting it run under the dock and dissolve.
    expect(canvas).not.toContain('padding-bottom')
  })

  it('dissolves the grid under the composer instead of clipping it', () => {
    const scroll = rule(css, '.notebook-horizontal-scroll')
    // Bottom padding on a scroll container is part of its scrollable extent,
    // so the last row still scrolls clear of the dock.
    expect(declaration(scroll, 'padding-bottom'))
      .toBe('var(--notebook-composer-clearance)')
    for (const property of ['mask-image', '-webkit-mask-image']) {
      const mask = declaration(scroll, property).replace(/\s+/gu, ' ')
      expect(mask).toContain('linear-gradient( 180deg, #000 0,')
      expect(mask).toContain('calc(100% - var(--notebook-fade-height))')
      expect(mask).toContain('transparent 100% )')
    }
    // Most of the ramp has to sit above the dock to read as a fade rather
    // than an edge.
    expect(declaration(rule(css, '.canvas'), '--notebook-fade-height'))
      .toBe('calc(var(--notebook-composer-clearance) + 88px)')
  })

  it('aligns the scroll container and both scrollbars on the chrome inset', () => {
    const scroll = rule(css, '.notebook-horizontal-scroll')
    expect(declaration(scroll, 'margin'))
      .toBe('var(--notebook-chrome-top) var(--notebook-chrome-inset) 0')
    expect(declaration(scroll, 'height'))
      .toBe('calc(100% - var(--notebook-chrome-top))')
    // The last column clears the scrollbar lane by the same gutter the first
    // column gets on the left.
    expect(declaration(scroll, 'padding-right')).toBe('var(--notebook-chrome-inset)')
    expect(declaration(scroll, 'scrollbar-gutter')).toBe('stable')
    expect(declaration(scroll, 'scrollbar-width')).toBe('auto')
    expect(declaration(scroll, 'scrollbar-color')).toBe('auto')
    const bar = rule(css, '.notebook-horizontal-scroll::-webkit-scrollbar')
    expect(declaration(bar, 'width')).toBe('var(--notebook-scrollbar-size)')
    expect(declaration(bar, 'height')).toBe('var(--notebook-scrollbar-size)')
    expect(declaration(rule(css, '.canvas'), '--notebook-scrollbar-size'))
      .toBe('10px')
  })

  it('does not reserve a side column for notebook inspector chrome', () => {
    const shell = rule(css, '.app-shell')
    expect(declaration(shell, 'grid-template')).toBe(
      'auto minmax(0, 1fr) / minmax(0, 1fr)',
    )
    expect(shell).not.toContain('--inspector-width')
    expect(css).not.toContain('.app-shell.inspector-hidden')
    expect(declaration(rule(css, '.app-screen-notebook .command-composer'), 'right'))
      .toBe('var(--app-gutter)')
    expect(app).toContain('composer-notebook-dock')
    expect(app).toContain('contextualContent={composerContextualContent}')
    expect(app).not.toContain('className="inspector-reopen"')
  })

  it('moves fullscreen image subject tools and music source/clip columns into the dock', () => {
    expect(fullscreen).toContain('dockPortal')
    expect(fullscreen).toContain("dockPortal ? ' docked'")
    expect(declaration(rule(css, '.notebook-media-fullscreen.docked'), 'grid-template-columns'))
      .toBe('minmax(0, 1fr)')
    expect(musicCss).toContain('.music-video-editor-main.docked')
    expect(rule(musicCss, '.music-video-editor-main.docked')).toContain("'preview'")
    expect(rule(musicCss, '.music-video-editor-main.docked')).toContain("'timeline'")
    expect(rule(musicCss, '.music-video-editor-main.docked')).not.toContain("'sources preview inspector'")
  })

  it('keeps confirm sheet actions outside the scrollable body', () => {
    const sheet = rule(css, '.confirm-sheet')
    expect(declaration(sheet, 'display')).toBe('grid')
    // The footer track is `auto` so it takes no height at all on a ready sheet,
    // whose hints the 40px header carries instead.
    expect(declaration(sheet, 'grid-template-rows')).toBe('40px minmax(0, 1fr) auto')
    const body = rule(css, '.confirm-sheet-body')
    expect(declaration(body, 'min-height')).toBe('0')
    expect(declaration(body, 'overflow')).toBe('auto')
    const foot = rule(css, '.confirm-sheet-foot')
    expect(declaration(foot, 'grid-template-columns')).toBe('minmax(0, 1fr) auto')
  })

  it('keeps the generation body responsive arrangements', () => {
    const editor = rule(css, '.confirm-generation')
    expect(declaration(editor, 'grid-template-areas').replace(/\s+/g, ' '))
      .toBe(`'inputs prompt model estimate' 'inputs prompt settings estimate'`)
    const tablet = braceBlock(css, css.indexOf('@media (max-width: 1180px) {'))
    expect(declaration(rule(tablet, '.confirm-generation'), 'grid-template-columns'))
      .toBe('repeat(2, minmax(0, 1fr))')
    const mobile = braceBlock(css, css.indexOf('@media (max-width: 900px) {'))
    expect(declaration(rule(mobile, '.confirm-generation'), 'grid-template-columns'))
      .toBe('minmax(0, 1fr)')
  })

  it('sizes compact generation review source cards from a shared token', () => {
    const review = rule(css, '.confirm-generation')
    expect(pixelCount(
      declaration(review, '--generation-review-source-preview-size'),
    )).toBe(72)
    const preview = rule(css, '.generation-review-source-preview')
    expect(declaration(preview, 'min-height'))
      .toBe('var(--generation-review-source-preview-size)')
    const media = rule(
      css,
      '.generation-review-source-preview > .media-library-asset-placeholder',
    )
    expect(declaration(media, 'height'))
      .toBe('var(--generation-review-source-preview-size)')
    expect(declaration(media, 'object-fit')).toBe('contain')
    const cardCap = 'calc(var(--generation-review-source-preview-size) + 33px)'
    expect(declaration(rule(css, '.generation-review-text-input'), 'min-height'))
      .toBe(cardCap)
    expect(declaration(rule(css, '.generation-review-source-add'), 'min-height'))
      .toBe(cardCap)
  })

  it('lets the generation settings box grow or scroll instead of clipping', () => {
    // Both rows size to their content, so the settings box is never squeezed to
    // a height its own fields exceed.
    expect(declaration(rule(css, '.confirm-generation'), 'grid-template-rows'))
      .toBe('auto auto')
    const settings = rule(css, '.generation-review-settings')
    // 132px fits a whole provider default, so 'Default · adaptive' and
    // 'Output format' stop truncating in a 328px column.
    expect(declaration(settings, 'grid-template-columns'))
      .toBe('repeat(auto-fit, minmax(132px, 1fr))')
    expect(declaration(settings, 'min-height')).toBe('0')
    expect(declaration(settings, 'overflow')).toBe('auto')
    const section = rule(css, '.generation-review-settings-section')
    expect(declaration(section, 'grid-template-rows')).toBe('auto minmax(0, 1fr)')
    const primary = rule(css, '.inspector-generation-primary')
    expect(declaration(primary, 'grid-template-columns'))
      .toBe('repeat(auto-fit, minmax(112px, 1fr))')
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

  it('sizes the fullscreen more-actions button like the close it sits beside', () => {
    const more = rule(css, '.notebook-media-more-actions')
    const close = rule(css, '.notebook-media-fullscreen-close,\n.notebook-media-capture-button')
    expect(pixelCount(declaration(more, 'width')))
      .toBe(pixelCount(declaration(close, 'width')))
    expect(pixelCount(declaration(more, 'height')))
      .toBe(pixelCount(declaration(close, 'height')))
    expect(declaration(rule(css, '.notebook-media-fullscreen-actions'), 'display'))
      .toBe('flex')
  })

  it('folds the docked subject workspace into one row at rest', () => {
    const collapsed = rule(
      css,
      '.command-composer-contextual .notebook-subject-panel[data-collapsed="true"]',
    )
    expect(declaration(collapsed, 'display')).toBe('flex')
    expect(declaration(collapsed, 'align-items')).toBe('center')
    const hidden = rule(
      css,
      '.notebook-subject-panel[data-collapsed="true"] > .notebook-subject-panel-body,\n.notebook-subject-panel[data-collapsed="true"] > .notebook-subject-actions',
    )
    expect(declaration(hidden, 'display')).toBe('none')
    const toolbar = rule(
      css,
      '.command-composer-contextual .notebook-subject-toolbar',
    )
    expect(pixelCount(declaration(toolbar, 'min-height'))).toBe(40)
    // The row it folds into is what lets it host the dock's close control.
    expect(fullscreen).toContain('<ComposerDockClose />')
    expect(fullscreen).toContain('notebook-subject-panel-controls')
  })

  it('gives the inspector and history chrome one 40px header row', () => {
    const composer = rule(css, '.command-composer')
    expect(declaration(composer, '--dock-h')).toBe('min(560px, 56dvh)')
    expect(declaration(composer, '--dock-header-h')).toBe('40px')
    expect(declaration(rule(css, '.composer-notebook-dock.inspector > header'), 'height'))
      .toBe('var(--dock-header-h, 40px)')
    expect(css).toContain(
      '--media-row-h: calc(var(--dock-h, 560px) - var(--dock-header-h, 40px) - 24px)',
    )
    expect(declaration(rule(css, '.inspector-media-body'), 'padding-bottom')).toBe('0')
    expect(app).toContain('<ComposerHistoryControls />')
    expect(fullscreen).toContain('<ComposerHistoryControls />')
  })

  it('gives the dock close one class both panels wear', () => {
    const close = rule(css, '.composer-dock-close')
    expect(pixelCount(declaration(close, 'width'))).toBe(30)
    expect(pixelCount(declaration(close, 'height'))).toBe(30)
    expect(css).not.toContain('.inspector-dock-close')
    expect(app).toContain('<ComposerDockClose />')
  })

  it('overrides only the gutter token at the 720px breakpoint', () => {
    const queryAt = css.indexOf('@media (max-width: 720px) {')
    expect(queryAt).toBeGreaterThan(-1)
    const mobile = braceBlock(css, queryAt)
    const mobileGap = declaration(rule(css, '.app-shell'), '--app-gap')
    expect(declaration(rule(mobile, '.app-shell'), '--app-gutter')).toBe(mobileGap)
  })
})
