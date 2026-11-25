import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { applyGraphicsEdits } from '../../server/src/graphics/edits'
import { layoutGraphics } from '../../server/src/graphics/layout'
import { graphicsDocumentFromLayers, type GraphicsDocument } from '../../server/src/graphics/model'
import { GraphicsInspector, type GraphicsInspectorTab } from '../../src/components/videobook/graphics/GraphicsInspector'
import { GraphicsLayers } from '../../src/components/videobook/graphics/GraphicsLayers'
import { GraphicsStageLayers } from '../../src/components/videobook/graphics/GraphicsStageLayers'
import { GraphicsTemplateThumb } from '../../src/components/videobook/graphics/GraphicsTemplateThumb'
import { graphicsAddLayer, graphicsLayerPlacements, graphicsRenderBlocker, parseGraphicsRead } from '../../src/videobook/graphics-model'

const SOURCE = { width: 1080, height: 1920, durationSeconds: 8 }
const document = graphicsDocumentFromLayers([
  { kind: 'box', name: 'Caption cover', color: '#F4F4F4', width: 0.5, height: 0.1, radius: 0.5, opacity: 0.9 },
  { kind: 'text', name: 'Title', items: [{ slot: 'headline', text: 'Red light legends' }] },
])
const [cover, title] = document.layers
const read = parseGraphicsRead({
  asset_id: 'video-1',
  address: '@a1',
  label: 'red light',
  source: { width: SOURCE.width, height: SOURCE.height, duration_seconds: SOURCE.durationSeconds, fps: 30, source_hash: 'hash' },
  saved: true,
  revision: 'r1',
  updated_at: null,
  document,
  fill: { handle: null, profile_url: null, credit: null },
  starters: [],
  images: {},
  render: null,
  burned: null,
})
const layout = layoutGraphics({ document, frame: SOURCE, measure: (text, font) => Array.from(text).length * font.size * 0.5 })
const coverBox = layout.find((entry) => entry.layerId === cover.id)!.box

function inspector(tab: GraphicsInspectorTab | null, disabled = false): string {
  return renderToStaticMarkup(createElement(GraphicsInspector, {
    document,
    layer: cover,
    read,
    imageChoices: [],
    box: coverBox,
    placement: null,
    playhead: () => 0,
    disabled,
    tab,
    onTab: () => undefined,
    onEdit: () => true,
    onFindClearSpot: async () => ({ ok: true, message: '' }),
  }))
}

function stage(selectedLayerId: string | null, editable = true): string {
  return renderToStaticMarkup(createElement(GraphicsStageLayers, {
    document,
    layout,
    source: SOURCE,
    seconds: 1,
    selectedLayerId,
    activeSlot: null,
    editable,
    snapping: true,
    guides: false,
    onSelectLayer: () => undefined,
    onEdit: () => true,
  }))
}

describe('the cover box in the graphics editor', () => {
  it('adds a box under the other layers from the add bar and lists it with its size', () => {
    const added = graphicsAddLayer(document, 'box')
    expect(added).toEqual({ layerId: 'l4', edit: { op: 'add_layer', layer: { kind: 'box' }, index: 0 } })
    const result = applyGraphicsEdits(document, [added!.edit])
    if (!result.ok) throw new Error(result.error.message)
    expect(result.document.layers.map((layer) => [layer.id, layer.kind])).toEqual([['l4', 'box'], [cover.id, 'box'], [title.id, 'text']])
    const html = renderToStaticMarkup(createElement(GraphicsLayers, {
      document,
      drawn: document,
      read,
      imageChoices: [],
      selectedLayerId: cover.id,
      warnings: {},
      disabled: false,
      playerRef: { current: null },
      onEdit: () => true,
      onSelect: () => undefined,
    }))
    expect(html).toMatch(/<button type="button" aria-label="Add box layer"><svg[^>]*>.*?<\/svg>Box<\/button>/u)
    expect(html).toMatch(/aria-label="Select layer Caption cover"><svg[^>]*lucide-square[^>]*>.*?<\/svg><span class="graphics-layer-title">Caption cover<\/span><span class="graphics-layer-summary">50% × 10% box<\/span>/u)
  })

  it('sets the box color, size and rounding on its own tab under the layer opacity', () => {
    const html = inspector(null)
    expect(html).toContain('role="group" aria-label="Box layer Caption cover"')
    expect(html).toMatch(/data-tab="box" aria-pressed="true">Box<\/button><button type="button" data-tab="place" aria-pressed="false">Place<\/button><button type="button" data-tab="timing" aria-pressed="false">Timing<\/button>/u)
    expect(html).toMatch(/<span>Opacity<output>90%<\/output><\/span>/u)
    expect(html).toContain('<input type="color" aria-label="Box color" value="#f4f4f4"/>')
    expect(html).toMatch(/<span>Width<output>50%<\/output><\/span><input type="range" aria-label="Width" min="0.01" max="1" step="0.005" value="0.5"\/>/u)
    expect(html).toMatch(/<span>Height<output>10%<\/output><\/span><input type="range" aria-label="Height" min="0.01" max="1" step="0.005" value="0.1"\/>/u)
    expect(html).toMatch(/<span>Corner rounding<output>50%<\/output><\/span>/u)
    expect(html).toContain('Drag the box over burned-in text in the preview')
    expect(inspector('block')).toMatch(/data-tab="box" aria-pressed="true">Box<\/button>/u)
    expect(inspector(null, true)).toContain('<input type="color" aria-label="Box color" disabled="" value="#f4f4f4"/>')
  })

  it('places the box by anchor anywhere in the frame without offering a clear spot or cover warnings', () => {
    const html = inspector('place')
    expect(html).toContain('aria-label="Place the layer"')
    expect(html).toMatch(/<select aria-label="Within">.*<option value="frame" selected="">Whole frame<\/option>/u)
    expect(html).not.toContain('Find clear spot')
    const placements = graphicsLayerPlacements(document, layout, { ...read, regions: [{ time: 1, regions: [{ kind: 'text', confidence: 0.9, ...{ x: 0.3, y: 0.75, width: 0.4, height: 0.05 } }] }] })
    expect(Object.keys(placements)).toEqual([title.id])
  })

  it('puts a resize handle on every corner and edge of the selected box', () => {
    const html = stage(cover.id)
    expect(html).toContain(`class="graphics-layer-box" data-layer-id="${cover.id}" data-box="270,1440,540,192" data-selected="true" data-draggable="true" aria-label="Select Caption cover"`)
    const handles = [...html.matchAll(/class="graphics-handle" data-handle="([a-z-]+)" data-layer-id="l1" title="Drag to resize the box" style="left:([\d.]+)%;top:([\d.]+)%;cursor:([a-z-]+)"/gu)]
      .map(([, handle, left, top, cursor]) => [handle, Number(left), Number(top), cursor])
    expect(handles).toEqual([
      ['top-left', 25, 75, 'nwse-resize'],
      ['top', 50, 75, 'ns-resize'],
      ['top-right', 75, 75, 'nesw-resize'],
      ['left', 25, 80, 'ew-resize'],
      ['right', 75, 80, 'ew-resize'],
      ['bottom-left', 25, 85, 'nesw-resize'],
      ['bottom', 50, 85, 'ns-resize'],
      ['bottom-right', 75, 85, 'nwse-resize'],
    ])
    expect(stage(cover.id, false)).not.toContain('graphics-handle')
    expect(stage(title.id)).not.toContain('Drag to resize the box')
  })

  it('draws the box in template thumbnails and counts it as something to render', () => {
    const html = renderToStaticMarkup(createElement(GraphicsTemplateThumb, { document, images: {} }))
    expect(html).toContain('<span class="graphics-thumb-plate" style="left:25%;top:75%;width:50%;height:10%;background:#F4F4F4;opacity:0.9"></span>')
    const boxOnly: GraphicsDocument = { ...document, layers: [cover] }
    expect(graphicsRenderBlocker(boxOnly, 8, false)).toBeNull()
    expect(graphicsRenderBlocker({ ...document, layers: [] }, 8, false)).toBe('Add text, an image, a QR code, a shade or a box to render.')
  })
})
