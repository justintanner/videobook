import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { graphicsDocumentFromLayers } from '../../server/src/graphics/model'
import { GraphicsInspector, type GraphicsInspectorTab } from '../../src/components/videobook/graphics/GraphicsInspector'
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

function inspector(layer = logo, layerPlacement: GraphicsLayerPlacement | null = placement(), disabled = false, tab: GraphicsInspectorTab | null = 'place'): string {
  return renderToStaticMarkup(createElement(GraphicsInspector, {
    document,
    layer,
    read,
    imageChoices: [],
    box: BOX,
    placement: layerPlacement,
    playhead: () => 0,
    disabled,
    tab,
    onTab: () => undefined,
    onEdit: () => true,
    onFindClearSpot: async () => ({ ok: true, message: '' }),
  }))
}

describe('frame-aware placement in the graphics editor', () => {
  it('marks layers that cover a face or on-screen text in the layer list', () => {
    const html = renderToStaticMarkup(createElement(GraphicsLayers, {
      document,
      drawn: document,
      read,
      imageChoices: [],
      selectedLayerId: null,
      warnings: { [logo.id]: 'Covers a face', [title.id]: 'Covers a face and on-screen text' },
      disabled: false,
      playerRef: { current: null },
      onEdit: () => true,
      onSelect: () => undefined,
    }))
    expect(html).toMatch(/<span class="graphics-layer-warning" role="note" aria-label="Logo: Covers a face"><svg[^>]*>.*?<\/svg>Covers a face<\/span>/u)
    expect(html).toContain('aria-label="Title: Covers a face and on-screen text"')
    expect(html.split('graphics-layer-warning').length - 1).toBe(2)
  })

  it('draws every layer as a timeline row with its window, the ruler scrubber and trim handles on the selected one', () => {
    const html = renderToStaticMarkup(createElement(GraphicsLayers, {
      document,
      drawn: document,
      read,
      imageChoices: [],
      selectedLayerId: title.id,
      warnings: {},
      disabled: false,
      playerRef: { current: null },
      onEdit: () => true,
      onSelect: () => undefined,
    }))
    expect(html.split('class="graphics-layer-row"').length - 1).toBe(3)
    expect(html.split('class="graphics-timing-row"').length - 1).toBe(3)
    expect(html).toContain(`data-layer-id="${title.id}" data-selected="true" data-window="0,8"`)
    expect(html).toContain('aria-label="Title: Shows 0–8 s of 8 s"')
    expect(html).toContain('<input type="range" class="graphics-seek" aria-label="Playback position" min="0" max="239" step="1" value="0"/>')
    expect(html).toContain('>0:00</span>')
    expect(html).toContain('>0:07</span>')
    expect(html).toContain('data-end="true" style="left:100.000%"></span>')
    expect(html).not.toContain('>0:08</span>')
    expect(html.split('class="graphics-trim-handle"').length - 1).toBe(2)
    expect(html).toContain(`data-bound="start" data-layer-id="${title.id}"`)
    expect(html).toContain(`data-bound="end" data-layer-id="${title.id}"`)
  })

  it('leaves the bar off a layer the look does not draw and the trim handles off a locked editor', () => {
    const drawn = { ...document, layers: document.layers.filter((layer) => layer.id !== shade.id) }
    const html = renderToStaticMarkup(createElement(GraphicsLayers, {
      document,
      drawn,
      read,
      imageChoices: [],
      selectedLayerId: title.id,
      warnings: {},
      disabled: true,
      playerRef: { current: null },
      onEdit: () => true,
      onSelect: () => undefined,
    }))
    expect(html.split('class="graphics-layer-row"').length - 1).toBe(3)
    expect(html.split('class="graphics-timing-row"').length - 1).toBe(2)
    expect(html).not.toContain(`class="graphics-timing-row" data-layer-id="${shade.id}"`)
    expect(html).not.toContain('graphics-trim-handle')
  })

  it('keeps the inspector to one section at a time under the layer opacity, starting on the layer kind', () => {
    const text = inspector(title, placement(), false, null)
    expect(text).toContain('role="group" aria-label="Text layer Title"')
    expect(text).toContain('aria-label="Inspector section"')
    expect(text).toMatch(/data-tab="text" aria-pressed="true">Text<\/button>.*data-tab="block" aria-pressed="false">Block<\/button>.*data-tab="place" aria-pressed="false">Place<\/button>.*data-tab="timing" aria-pressed="false">Timing<\/button>/u)
    expect(text).toContain('aria-label="Text items 1/6"')
    expect(text).toContain('aria-label="Item text"')
    expect(text).toContain('aria-label="Opacity"')
    expect(text).not.toContain('aria-label="Timing"')
    expect(text).not.toContain('aria-label="Block"')
    expect(text).not.toContain('Find clear spot')
    const image = inspector(logo, placement(), false, null)
    expect(image).toMatch(/data-tab="image" aria-pressed="true">Image<\/button>.*data-tab="place".*data-tab="timing"/u)
    expect(image).toContain('aria-label="Width"')
    expect(inspector(shade, null, false, null)).toMatch(/data-tab="shade" aria-pressed="true">Shade<\/button><button type="button" data-tab="timing" aria-pressed="false">Timing<\/button><\/div>/u)
  })

  it('keeps the section the operator chose across layers that have it, and falls back to the layer kind', () => {
    expect(inspector(title, placement(), false, 'timing')).toMatch(/data-tab="timing" aria-pressed="true">Timing<\/button>/u)
    expect(inspector(title, placement(), false, 'timing')).toContain('aria-label="Timing"')
    expect(inspector(logo, placement(), false, 'block')).toMatch(/data-tab="image" aria-pressed="true">Image<\/button>/u)
    expect(inspector(shade, null, false, 'place')).toMatch(/data-tab="shade" aria-pressed="true">Shade<\/button>/u)
    expect(inspector(title, placement(), false, 'block')).toContain('aria-label="Align"')
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
