import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { BookAction, ProjectBook } from 'videobook-engine'

import {
  parseBookAssets,
  projectBookEdges,
  projectBookNodes,
  projectMentionSlugs,
} from './project-book'
import { notebookGrid, notebookGridSlot } from './notebook-grid'

function action(
  id: string,
  partial: Partial<BookAction> = {},
): BookAction {
  return {
    id,
    projectId: 'project-1',
    operation: `book:${id}`,
    title: id,
    scope: 'artifact',
    actor: 'jwt',
    lane: 'human',
    date: `2026-01-01T00:00:0${id.length}.000Z`,
    phase: 'completed',
    parentActionIds: [],
    inputArtifacts: [],
    outputArtifacts: [],
    details: {},
    events: [{
      id: `${id}-event`,
      revision: id.repeat(40).slice(0, 40),
      phase: 'completed',
      date: `2026-01-01T00:00:0${id.length}.000Z`,
      details: {},
      files: [],
      fileChanges: [],
    }],
    ...partial,
  }
}

describe('project book canvas projection', () => {
  it('keeps all action details in the inspector while locked cards stay selectable', () => {
    const app = readFileSync(
      new URL('../App.tsx', import.meta.url),
      'utf8',
    )
    const inspector = readFileSync(
      new URL('../components/videobook/CellInspectorPanel.tsx', import.meta.url),
      'utf8',
    )
    const css = readFileSync(
      new URL('../index.css', import.meta.url),
      'utf8',
    )
    const cellNode = app.match(
      /function CellNode[\s\S]*?function textFromToolResult/,
    )?.[0]
    const nodeClick = app.match(
      /onNodeClick=\{\(_, node\) => \{[\s\S]*?onConnect=/,
    )?.[0]

    expect(cellNode).not.toContain('<button')
    expect(app).not.toContain('View history for')
    expect(app).not.toContain('View source for')
    expect(app).not.toContain('ActionDetailModal')
    expect(app).toContain('<CellInspectorPanel')
    expect(app).toContain('elementsSelectable')
    expect(app).not.toContain('elementsSelectable={flowInteractive}')
    expect(nodeClick).toContain("setInspectorTab('details')")
    expect(nodeClick).toContain('setPromptOpen(false)')
    expect(nodeClick).not.toContain('setPromptOpen(true)')
    expect(app).toContain('useState(false)')
    expect(app).toContain('panOnScroll={!flowInteractive}')
    expect(app).toContain('panOnScrollMode={PanOnScrollMode.Vertical}')
    expect(app).not.toContain('History trails')
    expect(app).not.toContain('cell-node-turn-flipped')
    expect(app).not.toContain('data.stage.toString()')
    expect(app).not.toContain('<small>{data.title}</small>')
    expect(app).toContain('position="top-left" className="palette-panel"')
    expect(cellNode).toContain('data.stage > 1')
    expect(app).toContain('orientation="horizontal"')
    expect(app).not.toContain('position="top-right"')
    expect(app).toContain('cell-copy cell-copy-prompt')
    expect(app).toContain("data.kind === 'prompt'")
    expect(inspector).toContain('role="tablist"')
    expect(inspector).toContain("{ id: 'details', label: 'Details' }")
    expect(inspector).toContain("{ id: 'history', label: 'History' }")
    expect(inspector).toContain("{ id: 'source', label: 'Source' }")
    expect(inspector).toContain('<RichJson value={cell.source} />')
    expect(css).toContain('.inspector-tabs')
    expect(css).toContain('.inspector-history')
    expect(css).toContain('.inspector-source-json')
    expect(css).not.toContain('.action-detail-modal')
    expect(css).toContain('--color-background: #030907')
    expect(css).toContain('.cell-copy-prompt')
    expect(css).toContain('-webkit-line-clamp: 8')
    expect(css).toContain('.react-flow__edge-textbg')
  })

  it('shows selected cell contents and media actions in the inspector', () => {
    const preview = readFileSync(
      new URL(
        '../components/videobook/CellInspectorPreview.tsx',
        import.meta.url,
      ),
      'utf8',
    )
    const css = readFileSync(
      new URL('../index.css', import.meta.url),
      'utf8',
    )

    expect(preview).toContain("cell.kind === 'video' && cell.mediaUrl")
    expect(preview).toContain('controls')
    expect(preview).toContain('<img src={previewUrl} alt={cell.slug} />')
    expect(preview).toContain("{cell.prompt || cell.operation}")
    expect(preview).toContain('target="_blank"')
    expect(preview).toContain('Play media')
    expect(preview).toContain('Open media')
    expect(preview).toContain('<a href={cell.mediaUrl} download>')
    expect(preview).toContain('<span>{cell.status}</span>')
    expect(css).toContain('.inspector-cell-media')
    expect(css).toContain('.inspector-media-actions')
  })

  it('bounds portrait media to the preview viewport', () => {
    const css = readFileSync(
      new URL('../index.css', import.meta.url),
      'utf8',
    )
    const rule = css.match(
      /\.cell-media img,\s*\.cell-media video\s*\{([^}]*)\}/,
    )?.[1]

    expect(rule).toContain('position: absolute')
    expect(rule).toContain('inset: 0')
    expect(rule).toContain('object-fit: contain')
  })

  it('uses right-aligned header icons and combines diagnostics with settings', () => {
    const app = readFileSync(
      new URL('../App.tsx', import.meta.url),
      'utf8',
    )
    const css = readFileSync(
      new URL('../index.css', import.meta.url),
      'utf8',
    )
    const headerNavigation = app.match(
      /<nav className="header-navigation"[\s\S]*?<\/nav>/,
    )?.[0]

    expect(headerNavigation).toContain('aria-label={`Open ${item.label}`}')
    expect(headerNavigation).not.toContain('<span')
    expect(app).not.toContain('className={`navigation')
    expect(app).not.toContain("id: 'diagnostics'")
    expect(app).toContain("open_diagnostics: 'settings'")
    expect(app).toContain('System diagnostics')
    expect(app).toContain("call('storage_status', {})")
    expect(css).not.toContain('.navigation {')
    expect(css).toContain('.header-navigation')
    expect(css).toContain('grid-template: 72px minmax(0, 1fr) / minmax(0, 1fr) 400px')
  })

  it('keeps notebook navigation and creation controls visibly legible', () => {
    const app = readFileSync(
      new URL('../App.tsx', import.meta.url),
      'utf8',
    )
    const css = readFileSync(
      new URL('../index.css', import.meta.url),
      'utf8',
    )
    const homeButton = app.match(
      /className="brand-project-home"[\s\S]*?<\/button>/,
    )?.[0]
    const paletteRule = css.match(
      /\.palette \{([^}]*)\}/,
    )?.[1]
    const commandShellRule = css.match(
      /\.command-line-shell \{([^}]*)\}/,
    )?.[1]
    const stageLabelRule = css.match(
      /\.notebook-stage-label \{([^}]*)\}/,
    )?.[1]
    const paletteMarkup = app.match(
      /<aside className="palette">[\s\S]*?<\/aside>/,
    )?.[0]

    expect(homeButton).toContain('title="Back to project book"')
    expect(homeButton).toContain('<span>/videobook</span>')
    expect(homeButton).not.toContain('<strong>')
    expect(app).toContain('<span className="section-label">ADD CELLS</span>')
    expect(app).toContain("shortLabel: 'Char'")
    expect(app).toContain('<span>Add {item.shortLabel ?? item.label}</span>')
    expect(app).not.toContain('className="palette-add"')
    expect(app).not.toContain('<MiniMap')
    expect(paletteMarkup).toContain('draggable={flowInteractive}')
    expect(paletteMarkup).toContain('disabled={busy}')
    expect(paletteMarkup).not.toContain('disabled={!flowInteractive || busy}')
    expect(paletteRule).toContain('width: 152px')
    expect(stageLabelRule).toContain('right: 104px')
    expect(stageLabelRule).toContain('left: auto')
    expect(stageLabelRule).toContain('rgba(151, 235, 188, 0.42)')
    expect(stageLabelRule).toContain('writing-mode: vertical-rl')
    expect(css).toContain('opacity: 0.68')
    expect(notebookGrid.originX).toBe(232)
    expect(notebookGrid.minStages).toBe(6)
    expect(app).toContain('extendStageRunway(viewport)')
    expect(app).toContain('clampNotebookViewport(viewport)')
    expect(css).toContain('left: 56px')
    expect(css).toContain('right: 440px')
    expect(commandShellRule).toContain('border-right-width: 3px')
    expect(commandShellRule).toContain('border-left-width: 3px')
    expect(css).toContain('font-size: 14px')
  })

  it('renders artifact actions with media, slugs, causal edges, and layout trail', () => {
    const prompt = action('prompt-action', {
      outputArtifacts: [{
        id: 'prm-cat',
        slug: '@prm-cat',
        kind: 'prompt',
      }],
      layout: { stage: 0, column: 0 },
      details: {
        entry: {
          id: 'prm-cat',
          kind: 'prompt',
          prompt: 'A white cat dancing',
        },
      },
    })
    const image = action('image-action', {
      operation: 'book:tool-generate-nano-banana-pro-google',
      title: 'generate nano banana pro google',
      inputArtifacts: [{
        id: 'prm-cat',
        slug: '@prm-cat',
        kind: 'prompt',
      }],
      outputArtifacts: [{
        id: 'img-cat',
        slug: '@img-cat',
        kind: 'image',
      }],
    })
    const layout = action('layout-action', {
      scope: 'layout',
      targetActionId: 'image-action',
      layout: { stage: 2, column: 3 },
      outputArtifacts: [],
    })
    const book: ProjectBook = {
      projectId: 'project-1',
      slug: 'studio',
      headRevision: 'f'.repeat(40),
      actions: [prompt, image, layout],
    }
    const assets = parseBookAssets({
      assets: [{
        id: 'img-cat',
        type: 'image',
        media_url: '/files/studio/img-cat/original.png',
        thumbnail_url: '/files/studio/img-cat/original.png',
        width: 1024,
        height: 1792,
        status: 'ready',
      }],
    })

    const nodes = projectBookNodes(book, assets)
    expect(nodes.map((node) => node.id)).toEqual([
      'prompt-action',
      'image-action',
    ])
    const imageNode = nodes.find((node) => node.id === 'image-action')
    expect(imageNode?.data).toMatchObject({
      slug: '@img-cat',
      mediaUrl: '/files/studio/img-cat/original.png',
      width: 1024,
      height: 1792,
      source: image,
    })
    expect(notebookGridSlot(imageNode!.position)).toEqual({
      stage: 2,
      column: 3,
    })
    expect(imageNode?.data.trail.map((item) => item.id)).toContain(
      'layout-action-event',
    )
    expect(projectBookEdges(book)).toEqual([
      expect.objectContaining({
        source: 'prompt-action',
        target: 'image-action',
      }),
    ])
    expect(projectMentionSlugs(nodes, assets)).toEqual([
      'prm-cat',
      'img-cat',
    ])
  })
})
