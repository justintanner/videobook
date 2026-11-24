import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CellRouteBadge } from '../../src/components/videobook/CellRouteBadge'
import {
  notebookIncomingRouteBadge,
  notebookOutgoingRouteBadge,
  type NotebookRouteTag,
} from '../../src/videobook/notebook-route-tags'

const generationInputs: NotebookRouteTag[] = [
  { address: '@d1', tokens: ['video1'], type: 'video' },
  { address: '@c1', tokens: ['image1'], type: 'image' },
  { address: '@c2', tokens: ['image2'], type: 'image' },
]

describe('cell route badges', () => {
  it('labels each generation input with its slot name and source address', () => {
    const html = renderToStaticMarkup(createElement(CellRouteBadge, {
      direction: 'incoming',
      badge: notebookIncomingRouteBadge(generationInputs),
    }))

    expect(html).toContain('class="cell-route-badge cell-route-badge-incoming"')
    expect(html).toContain('data-tone="mixed"')
    expect(html).toContain('<span class="sr-only">Fed by @d1 into video1, @c1 into image1, @c2 into image2</span>')
    expect(html).toContain('<span class="cell-route-segment" data-family="video"><span class="cell-route-slot">video1</span><span class="cell-route-address">d1</span></span>')
    expect(html).toContain('<span class="cell-route-slot">image2</span><span class="cell-route-address">c2</span>')
    expect(html).not.toContain('cell-route-arrow')
  })

  it('marks a producer link with an icon instead of a slot', () => {
    const html = renderToStaticMarkup(createElement(CellRouteBadge, {
      direction: 'incoming',
      badge: notebookIncomingRouteBadge([{ address: '@b2', tokens: [], type: 'generate_image' }]),
    }))

    expect(html).toContain('data-tone="gen"')
    expect(html).toContain('data-family="gen"><svg')
    expect(html).not.toContain('cell-route-slot')
  })

  it('points outputs at their targets and leaves slot keycaps to the target', () => {
    const many = renderToStaticMarkup(createElement(CellRouteBadge, {
      direction: 'outgoing',
      badge: notebookOutgoingRouteBadge([
        { address: '@b1', tokens: [], type: 'goal' },
        { address: '@b2', tokens: ['image1'], type: 'generate_image' },
      ]),
    }))
    const single = renderToStaticMarkup(createElement(CellRouteBadge, {
      direction: 'outgoing',
      badge: notebookOutgoingRouteBadge([{ address: '@b4', tokens: ['image2'], type: 'generate_video' }]),
    }))

    expect(many).toContain('cell-route-arrow')
    expect(many).not.toContain('data-tone')
    expect(many).toContain('data-family="goal"><span class="cell-route-address">b1</span></span>')
    expect(many).toContain('data-family="gen"><span class="cell-route-address">b2</span></span>')
    expect(single).toContain('data-family="gen"><span class="cell-route-address">b4</span></span>')
    expect(single).not.toContain('cell-route-slot')
    expect(single).toContain('<span class="sr-only">Feeds @b4 as image2</span>')
  })

  it('follows the addresses with a detail, or carries a detail alone', () => {
    const joined = renderToStaticMarkup(createElement(CellRouteBadge, {
      direction: 'incoming',
      badge: notebookIncomingRouteBadge([{ address: '@b2', tokens: [], type: 'generate_video' }]),
      detail: createElement('span', null, 'Kie'),
      detailLabel: 'Made with Kie',
    }))
    const alone = renderToStaticMarkup(createElement(CellRouteBadge, {
      direction: 'incoming',
      badge: null,
      detail: createElement('span', null, '0:07'),
      detailLabel: 'Frame at 0:07',
    }))

    expect(joined).toContain('<span class="sr-only">Fed by @b2 · Made with Kie</span>')
    expect(joined).toContain('<span class="cell-route-address">b2</span></span><span class="cell-route-detail"><span>Kie</span></span>')
    expect(alone).toContain('<span class="sr-only">Frame at 0:07</span>')
    expect(alone).toContain('<span class="cell-route-badge-fill"><span class="cell-route-detail"><span>0:07</span></span></span>')
    expect(alone).not.toContain('data-tone')
  })

  it('collapses long lists into a count and renders nothing without links', () => {
    const tags: NotebookRouteTag[] = ['@d1', '@d2', '@d3', '@d4'].map((address) => ({
      address,
      tokens: [],
      type: 'video',
    }))

    const outputs = renderToStaticMarkup(createElement(CellRouteBadge, {
      direction: 'outgoing',
      badge: notebookOutgoingRouteBadge(tags),
    }))
    const inputs = renderToStaticMarkup(createElement(CellRouteBadge, {
      direction: 'incoming',
      badge: notebookIncomingRouteBadge(tags),
    }))

    expect(outputs).toContain('<span class="cell-route-address">d2</span></span><span class="cell-route-more">+2</span>')
    expect(outputs).not.toContain('<span class="cell-route-address">d3</span>')
    expect(inputs).toContain('<span class="cell-route-address">d3</span></span><span class="cell-route-more">+1</span>')
    expect(renderToStaticMarkup(createElement(CellRouteBadge, {
      direction: 'incoming',
      badge: notebookIncomingRouteBadge([]),
    }))).toBe('')
  })
})
