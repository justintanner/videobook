import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { BookAction, ProjectBook } from 'videobook-engine'

import {
  parseBookAssets,
  projectBookEdges,
  projectBookNodes,
} from './project-book'
import { notebookGridSlot } from './notebook-grid'

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
  it('opens history and rich source in a modal while locked scrolling stays vertical', () => {
    const app = readFileSync(
      new URL('../App.tsx', import.meta.url),
      'utf8',
    )
    const modal = readFileSync(
      new URL('../components/videobook/ActionDetailModal.tsx', import.meta.url),
      'utf8',
    )
    const css = readFileSync(
      new URL('../index.css', import.meta.url),
      'utf8',
    )

    expect(app).toContain('View history for')
    expect(app).toContain('View source for')
    expect(app).toContain('useState(false)')
    expect(app).toContain('panOnScroll={!flowInteractive}')
    expect(app).toContain('panOnScrollMode={PanOnScrollMode.Vertical}')
    expect(app).not.toContain('History trails')
    expect(app).not.toContain('cell-node-turn-flipped')
    expect(app).not.toContain('data.stage.toString()')
    expect(app).not.toContain('<small>{data.title}</small>')
    expect(app).toContain('position="top-left" className="palette-panel"')
    expect(app).toContain('position="top-right"')
    expect(app).toContain('cell-copy cell-copy-prompt')
    expect(app).toContain("data.kind === 'prompt'")
    expect(modal).toContain('role="tablist"')
    expect(modal).toContain('<RichJson value={cell.source} />')
    expect(css).toContain('.action-detail-modal')
    expect(css).toContain('width: 80vw')
    expect(css).toContain('height: 80vh')
    expect(css).toContain('--color-background: #030907')
    expect(css).toContain('.cell-copy-prompt')
    expect(css).toContain('-webkit-line-clamp: 8')
    expect(css).toContain('.react-flow__edge-textbg')
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
          title: 'Dancing cat prompt',
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
  })
})
