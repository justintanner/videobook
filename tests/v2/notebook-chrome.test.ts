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

  it('pads every cell band from one detail-scaled gutter', () => {
    // Anchored on a line start: the review rules' `> .cell-node {` come first.
    const cell = rule(css, '\n.cell-node')
    expect(declaration(cell, '--cell-gutter'))
      .toBe('calc(22px * var(--notebook-detail-scale, 1))')
    expect(declaration(cell, '--cell-gutter-tight'))
      .toBe('calc(14px * var(--notebook-detail-scale, 1))')
    const header = rule(css, '.cell-node-header')
    expect(declaration(header, 'min-height'))
      .toBe('max(36px, calc(24px * var(--notebook-detail-scale, 1)))')
    expect(declaration(header, 'padding')).toBe('3px var(--cell-gutter)')
    expect(declaration(rule(css, '.cell-copy-text'), 'padding'))
      .toBe('var(--cell-gutter-tight) var(--cell-gutter)')
    expect(declaration(rule(css, '.cell-copy-analysis'), 'padding'))
      .toBe('12px var(--cell-gutter)')
    expect(declaration(rule(css, '.cell-media-rail'), 'padding'))
      .toBe('0 var(--cell-gutter)')
    // The meter is padded by the gutter too, so the corner the rail leaves
    // it has to grow with the gutter.
    expect(declaration(rule(css, '.cell-media:has(.cell-media-meter) .cell-media-rail'), 'padding-right'))
      .toBe('calc(3.35em + var(--cell-gutter))')
  })

  it('prints generation settings as plain text so a dense header keeps one line', () => {
    // Outlined chips are what wrapped GEN VID · 10s · adaptive onto a second
    // line once the gutter grew.
    const setting = rule(css, '.cell-aspect-ratio')
    expect(setting).not.toContain('border')
    expect(setting).not.toContain('padding')
    expect(declaration(setting, 'white-space')).toBe('nowrap')
    expect(declaration(rule(css, '.cell-aspect-ratio + .cell-aspect-ratio::before'), 'content'))
      .toBe("'·'")
  })

  it('dissolves the grid under the composer instead of clipping it', () => {
    const scroll = rule(css, '.notebook-horizontal-scroll')
    // Bottom padding on a scroll container is part of its scrollable extent,
    // so the last row still scrolls clear of the dock.
    expect(declaration(scroll, 'padding-bottom'))
      .toBe('max(var(--notebook-composer-clearance), calc(var(--notebook-composer-height, 0px) + var(--app-gutter) + var(--app-gap) + 16px))')
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

  it('splits fullscreen into a full-bleed viewer and a three-column image editor, and gives the music editor side columns it can hide', () => {
    expect(fullscreen).toContain("editing ? 'image-editor' : 'media-viewer'")
    expect(fullscreen).not.toContain('dockPortal')
    expect(declaration(rule(css, '.media-fullscreen-stage'), 'inset')).toBe('0')
    expect(declaration(rule(css, '.notebook-media-fullscreen.image-editor'), 'grid-template-columns'))
      .toBe('76px minmax(0, 1fr) minmax(320px, 400px)')
    expect(rule(musicCss, '.music-video-editor-main')).toContain("'library preview inspector' 'timeline timeline timeline'")
    expect(rule(musicCss, '.music-video-editor-main.tools-hidden')).toContain("'preview' 'timeline'")
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
      .toBe(`'inputs editor source estimate'`)
    const tablet = braceBlock(css, css.indexOf('@media (max-width: 1180px) {'))
    expect(declaration(rule(tablet, '.confirm-generation'), 'grid-template-columns'))
      .toBe('152px minmax(0, 1.2fr) minmax(0, 1fr)')
    const mobile = braceBlock(css, css.indexOf('@media (max-width: 900px) {'))
    expect(declaration(rule(mobile, '.confirm-generation'), 'grid-template-columns'))
      .toBe('minmax(0, 1fr)')
  })

  it('sizes compact generation review source cards from a shared token', () => {
    const review = rule(css, '.confirm-generation')
    expect(pixelCount(
      declaration(review, '--generation-review-source-preview-size'),
    )).toBe(56)
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
      .toBe('40px')
  })

  it('lets the generation settings box grow or scroll instead of clipping', () => {
    expect(declaration(rule(css, '.confirm-generation'), 'grid-template-rows'))
      .toBe('auto')
    const settings = rule(css, '.generation-review-settings')
    // 132px fits a whole provider default, so 'Default · adaptive' and
    // 'Output format' stop truncating in a 328px column.
    expect(declaration(settings, 'grid-template-columns'))
      .toBe('repeat(auto-fit, minmax(min(100%, 132px), 1fr))')
    expect(declaration(settings, 'min-height')).toBe('0')
    expect(declaration(settings, 'overflow')).toBe('auto')
    const section = rule(css, '.generation-review-settings-section')
    expect(declaration(section, 'grid-template-rows')).toBe('minmax(0, 1fr)')
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

  it('sizes the fullscreen close and editor icon buttons alike', () => {
    const buttons = rule(css, '.media-fullscreen-edit,\n.notebook-media-capture-button,\n.notebook-media-fullscreen-close,\n.image-editor-icon-button')
    expect(pixelCount(declaration(buttons, 'height'))).toBe(42)
    expect(pixelCount(declaration(buttons, 'min-width'))).toBe(42)
    expect(declaration(rule(css, '.notebook-media-fullscreen-actions'), 'display'))
      .toBe('flex')
    expect(css).not.toContain('.notebook-media-more-actions')
    expect(css).not.toContain('notebook-subject-panel[data-collapsed')
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
    expect(app).not.toContain('<ComposerHistoryControls />')
    expect(fullscreen).not.toContain('<ComposerHistoryControls />')
  })

  it('gives the dock close one class both panels wear', () => {
    const close = rule(css, '.composer-dock-close')
    expect(pixelCount(declaration(close, 'width'))).toBe(30)
    expect(pixelCount(declaration(close, 'height'))).toBe(30)
    expect(css).not.toContain('.inspector-dock-close')
    expect(app).toMatch(/<ComposerDockClose\s/)
  })

  it('overrides only the gutter token at the 720px breakpoint', () => {
    const queryAt = css.indexOf('@media (max-width: 720px) {')
    expect(queryAt).toBeGreaterThan(-1)
    const mobile = braceBlock(css, queryAt)
    const mobileGap = declaration(rule(css, '.app-shell'), '--app-gap')
    expect(declaration(rule(mobile, '.app-shell'), '--app-gutter')).toBe(mobileGap)
  })
})
