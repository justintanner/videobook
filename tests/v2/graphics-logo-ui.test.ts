import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { appendGraphicsLayers, graphicsDocumentFromLayers, type GraphicsDocument, type GraphicsImageLayerInput } from '../../server/src/graphics/model'
import { GraphicsLogo } from '../../src/components/videobook/graphics/GraphicsLogo'
import { parseGraphicsRead } from '../../src/videobook/graphics-model'

const BOOK_LOGO = { asset_id: 'logo-1', position: { anchor: 'bottom-right', x: 1, y: 1, space: 'safe' }, size: 0.155, opacity: 0.55 }
const CHOICES = [
  { artifactId: 'logo-1', address: 'c2', label: 'thumb3', url: '/files/book/logo-1/original.png' },
  { artifactId: 'face-1', address: 'c1', label: 'face', url: '/files/book/face-1/original.png' },
]

function look(): GraphicsDocument {
  return graphicsDocumentFromLayers([
    { kind: 'scrim', edge: 'top' },
    { kind: 'text', name: 'Headline', items: [{ slot: 'headline', text: 'การเตรียมตัวสำหรับวันลอยกระทง' }] },
  ])
}

function withLogo(layer: Partial<GraphicsImageLayerInput>): GraphicsDocument {
  return appendGraphicsLayers(look(), [{ kind: 'image', name: 'Logo', role: 'logo', artifactId: 'logo-1', size: 0.155, opacity: 0.55, position: BOOK_LOGO.position, ...layer } as GraphicsImageLayerInput])
}

function html(document: GraphicsDocument, logo: typeof BOOK_LOGO | null, disabled = false): string {
  const read = parseGraphicsRead({
    asset_id: 'video-1',
    address: '@d1',
    label: 'Wan 3.0',
    source: { width: 1080, height: 1920, duration_seconds: 15, fps: 30, source_hash: 'hash' },
    saved: true,
    revision: 'r1',
    updated_at: null,
    document,
    fill: { handle: 'jtbkk', profile_url: null, credit: null },
    starters: [],
    logo,
    images: { 'logo-1': { label: 'thumb3', url: '/files/book/logo-1/original.png', width: 1254, height: 1254 } },
    render: null,
    burned: null,
    watermark: null,
  })
  return renderToStaticMarkup(createElement(GraphicsLogo, {
    document,
    read,
    imageChoices: CHOICES,
    bookName: 'loyk',
    disabled,
    onEdit: () => true,
    onSetDefault: async () => ({ ok: true, message: '' }),
  }))
}

describe('graphics logo section', () => {
  it('offers None and the book logo, and keeps the corner, size and opacity locked until a logo is on', () => {
    const markup = html(look(), BOOK_LOGO)
    expect(markup).toContain('<section class="graphics-logo" aria-label="Logo">')
    expect(markup).toContain('Book default</span>')
    expect(markup).toMatch(/<button type="button" class="graphics-logo-tile" aria-pressed="true" title="No logo on this video">/u)
    expect(markup).toMatch(/aria-pressed="false" title="@c2, the book’s logo"><span class="graphics-logo-tile-box" aria-hidden="true"><img src="\/files\/book\/logo-1\/original.png"/u)
    expect(markup).toMatch(/aria-label="Logo in the bottom right corner"[^>]*aria-pressed="false" disabled=""/u)
    expect(markup).toMatch(/aria-label="Logo size"[^>]*disabled=""/u)
    expect(markup).toMatch(/<input type="checkbox" role="switch" checked=""\/><span>Start new videos in loyk with this logo<\/span>/u)
    expect(markup).not.toContain('Update default')
  })

  it('shows this video’s logo, its corner, size and opacity, and offers to update a default that differs', () => {
    const moved = html(withLogo({ size: 0.2, position: { anchor: 'top-left', x: 0, y: 0, space: 'safe' } }), BOOK_LOGO)
    expect(moved).toMatch(/aria-pressed="true" title="@c2, the book’s logo">/u)
    expect(moved).toMatch(/aria-label="Logo in the top left corner"[^>]*aria-pressed="true"/u)
    expect(moved).toContain('<span>Logo size<output>20%</output></span>')
    expect(moved).toContain('<span>Logo opacity<output>55%</output></span>')
    expect(moved).toContain('>Update default</button>')
    expect(html(withLogo({}), BOOK_LOGO)).not.toContain('Update default')
  })

  it('leaves the default switch off without a book logo and disabled when there is nothing to keep', () => {
    const unset = html(withLogo({}), null)
    expect(unset).not.toContain('Book default')
    expect(unset).toMatch(/<input type="checkbox" role="switch"\/><span>Start new videos in loyk with this logo<\/span>/u)
    expect(html(look(), null)).toMatch(/<input type="checkbox" role="switch" disabled=""\/>/u)
    expect(html(look(), null)).not.toContain('title="@c2, the book’s logo"')
  })
})
