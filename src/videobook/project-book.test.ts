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

    const nodes = projectBookNodes(book, assets, true)
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
      historyExpanded: true,
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
