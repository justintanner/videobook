import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { graphicsDocumentFromLayers } from '../../server/src/graphics/model'
import { GraphicsInspector } from '../../src/components/videobook/graphics/GraphicsInspector'
import { GraphicsLayers } from '../../src/components/videobook/graphics/GraphicsLayers'
import { parseGraphicsRead, type GraphicsLayerPlacement } from '../../src/videobook/graphics-model'

const document = graphicsDocumentFromLayers([
  { kind: 'scrim', edge: 'bottom' },
  { kind: 'image', name: 'Logo', artifactId: 'logo' },
  { kind: 'text', name: 'Title', items: [{ slot: 'headline', text: 'ร่มชมพู' }] },
])
const [shade, logo, title] = document.layers
const read = parseGraphicsRead({
  asset_id: 'video-1',
  address: '@a1',
  label: 'red light',
  source: { width: 1080, height: 1920, duration_seconds: 8, fps: 30, source_hash: 'hash' },
  saved: true,
  revision: 'r1',
  updated_at: null,
  document,
  fill: { handle: null, profile_url: null, credit: null },
  starters: [],
  images: { logo: { label: 'logo', url: '/files/book/logo/original.png', width: 40, height: 20 } },
  render: null,
  burned: null,
})
const BOX = { x: 0, y: 1500, width: 400, height: 200 }

function placement(overrides: Partial<GraphicsLayerPlacement> = {}): GraphicsLayerPlacement {
  return { covers: [{ kind: 'face', time: 0.5 }], unchecked: 0, drawn: BOX, block: BOX, ...overrides }
}

function inspector(layer = logo, layerPlacement: GraphicsLayerPlacement | null = placement(), disabled = false): string {
  return renderToStaticMarkup(createElement(GraphicsInspector, {
    document,
    layer,
    read,
    imageChoices: [],
    box: BOX,
    placement: layerPlacement,
    playhead: () => 0,
    disabled,
    onEdit: () => true,
    onFindClearSpot: async () => ({ ok: true, message: '' }),
  }))
}

describe('frame-aware placement in the graphics editor', () => {
  it('marks layers that cover a face or on-screen text in the layer list', () => {
    const html = renderToStaticMarkup(createElement(GraphicsLayers, {
      document,
      read,
      imageChoices: [],
      selectedLayerId: null,
      warnings: { [logo.id]: 'Covers a face', [title.id]: 'Covers a face and on-screen text' },
      disabled: false,
      onEdit: () => true,
      onSelect: () => undefined,
    }))
    expect(html).toMatch(/<span class="graphics-layer-warning" role="note" aria-label="Logo: Covers a face"><svg[^>]*>.*?<\/svg>Covers a face<\/span>/u)
    expect(html).toContain('aria-label="Title: Covers a face and on-screen text"')
    expect(html.split('graphics-layer-warning').length - 1).toBe(2)
  })

  it('offers a free clear spot when every frame of the window is checked', () => {
    const html = inspector()
    expect(html).toMatch(/<button type="button" title="Move this layer to the anchor that covers the fewest faces and on-screen text\.">.*Find clear spot<\/button>/u)
    expect(html).toContain('<span class="graphics-clear-spot-warning">Covers a face while it is shown.</span>')
    expect(html).not.toContain('paid model call')
  })

  it('says finding a clear spot checks unchecked frames with a paid call first', () => {
    const html = inspector(title, placement({ covers: [], unchecked: 3 }))
    expect(html).toContain('First finds faces and on-screen text in 3 frames with one paid model call.')
    expect(html).toContain('<span class="graphics-muted">Checks 3 frames for faces and on-screen text first, a paid model call.</span>')
    expect(html).not.toContain('graphics-clear-spot-warning')
    expect(inspector(title, placement({ covers: [], unchecked: 1 }))).toContain('Checks 1 frame for faces')
  })

  it('cannot move a layer that draws nothing, a locked editor or a shade', () => {
    expect(inspector(title, placement({ drawn: null }))).toMatch(/<button type="button" disabled="" title="This layer draws nothing yet\.">.*Find clear spot<\/button>/u)
    expect(inspector(logo, null)).toContain('title="This layer draws nothing yet."')
    expect(inspector(logo, placement(), true)).toMatch(/<button type="button" disabled="" title="Move this layer[^"]*">.*Find clear spot<\/button>/u)
    expect(inspector(shade, null)).not.toContain('Find clear spot')
  })
})
