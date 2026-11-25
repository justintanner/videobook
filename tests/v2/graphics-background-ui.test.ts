import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { graphicsDocumentFromLayers, type GraphicsTextLayer } from '../../server/src/graphics/model'
import { GraphicsInspector, type GraphicsInspectorTab } from '../../src/components/videobook/graphics/GraphicsInspector'
import { parseGraphicsRead } from '../../src/videobook/graphics-model'

const document = graphicsDocumentFromLayers([
  { kind: 'text', name: 'Bare', items: [{ slot: 'headline', text: 'การทำความสะอาด' }] },
  { kind: 'text', name: 'Covered', items: [{ slot: 'headline', text: 'เทศกาลลอยกระทง' }], plate: { color: '#101010', opacity: 1 } },
])
const [bare, covered] = document.layers as GraphicsTextLayer[]
const read = parseGraphicsRead({
  asset_id: 'video-1',
  address: '@d1',
  label: 'burned-in captions',
  source: { width: 1080, height: 1920, duration_seconds: 15, fps: 30, source_hash: 'hash' },
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

function inspector(layer: GraphicsTextLayer, tab: GraphicsInspectorTab): string {
  return renderToStaticMarkup(createElement(GraphicsInspector, {
    document,
    layer,
    read,
    imageChoices: [],
    box: null,
    placement: null,
    playhead: () => 0,
    disabled: false,
    tab,
    onTab: () => undefined,
    onEdit: () => true,
    onFindClearSpot: async () => ({ ok: true, message: '' }),
  }))
}

function backgroundSwitch(html: string): string | null {
  return html.match(/<label class="graphics-switch"><input type="checkbox" role="switch"[^>]*\/><span>Background<\/span><\/label>/u)?.[0] ?? null
}

describe('text layer background in the graphics inspector', () => {
  it('offers the background switch on the Text tab beside the text styling, off until it is turned on', () => {
    const html = inspector(bare, 'text')
    expect(html).toContain('aria-label="Text items 1/6"')
    expect(html).toContain('aria-label="Background"')
    expect(backgroundSwitch(html)).not.toBeNull()
    expect(backgroundSwitch(html)).not.toContain('checked')
    expect(html).toContain('At 100% opacity it hides text burned into the video.')
    expect(html).not.toContain('aria-label="Background color"')
    expect(html).not.toContain('Background opacity')
  })

  it('shows the background color and opacity on the Text tab and leaves its shape to Block', () => {
    const html = inspector(covered, 'text')
    expect(backgroundSwitch(html)).toContain('checked')
    expect(html).toContain('<input type="color" aria-label="Background color" value="#101010"/>')
    expect(html).toMatch(/<span>Background opacity<output>100%<\/output><\/span><input type="range" aria-label="Background opacity"/u)
    expect(html).toContain('Padding, corners and border are under Block.')
    expect(html).not.toContain('Padding across')
    expect(html).not.toContain('Corner rounding')
    expect(html).not.toContain('Background border')
  })

  it('keeps the whole background, shape included, on the Block tab', () => {
    const html = inspector(covered, 'block')
    expect(html).toContain('aria-label="Block"')
    expect(backgroundSwitch(html)).toContain('checked')
    expect(html).toContain('aria-label="Background color"')
    expect(html).toContain('aria-label="Background opacity"')
    expect(html).toContain('aria-label="Padding across"')
    expect(html).toContain('aria-label="Padding down"')
    expect(html).toContain('aria-label="Corner rounding"')
    expect(html).toContain('<span>Background border</span>')
    expect(html).not.toContain('Backing plate')
    expect(html).not.toContain('aria-label="Text items 1/6"')
  })
})
