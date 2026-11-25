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

describe('text layer background in the graphics inspector', () => {
  it('shows background color and opacity on the Text tab with no background as opacity Off and a hint to drag it up', () => {
    const html = inspector(bare, 'text')
    expect(html).toContain('aria-label="Text items 1/6"')
    expect(html).toContain('aria-label="Background"')
    expect(html).toContain('<input type="color" aria-label="Background color" value="#000000"/>')
    expect(html).toMatch(/<span>Background opacity<output>Off<\/output><\/span><input type="range" aria-label="Background opacity" min="0" max="1" step="0.01" value="0"\/>/u)
    expect(html).toContain('Drag Background opacity up to put a box behind this text. At 100% it hides text burned into the video.')
    expect(html).not.toContain('role="switch"><span>Background')
    expect(html).not.toContain('Padding across')
  })

  it('shows the layer background on the Text tab and leaves its shape to Block', () => {
    const html = inspector(covered, 'text')
    expect(html).toContain('<input type="color" aria-label="Background color" value="#101010"/>')
    expect(html).toMatch(/<span>Background opacity<output>100%<\/output><\/span><input type="range" aria-label="Background opacity"[^>]*value="1"\/>/u)
    expect(html).toContain('Padding, corners and border are under Block.')
    expect(html).not.toContain('Drag Background opacity up')
    expect(html).not.toContain('Padding across')
    expect(html).not.toContain('Corner rounding')
    expect(html).not.toContain('Background border')
  })

  it('keeps the whole background, shape included, on the Block tab', () => {
    const html = inspector(covered, 'block')
    expect(html).toContain('aria-label="Block"')
    expect(html).toContain('aria-label="Background color"')
    expect(html).toContain('aria-label="Background opacity"')
    expect(html).toContain('aria-label="Padding across"')
    expect(html).toContain('aria-label="Padding down"')
    expect(html).toContain('aria-label="Corner rounding"')
    expect(html).toContain('<span>Background border</span>')
    expect(html).not.toContain('Backing plate')
    expect(html).not.toContain('under Block')
    expect(html).not.toContain('aria-label="Text items 1/6"')
  })

  it('offers the same off background and hint on the Block tab with no shape controls yet', () => {
    const html = inspector(bare, 'block')
    expect(html).toMatch(/<span>Background opacity<output>Off<\/output><\/span>/u)
    expect(html).toContain('Drag Background opacity up to put a box behind this text.')
    expect(html).not.toContain('Padding across')
  })
})
