import { describe, expect, it } from 'vitest'
import { graphicsDocumentFromLayers, type GraphicsDocument } from '../../server/src/graphics/model'
import { GRAPHICS_STARTERS, type GraphicsStarterId } from '../../server/src/graphics/starters'
import { graphicsThumbShapes, type GraphicsThumbShape } from './graphics-thumb'

const FRAME = { width: 1080, height: 1920 }

function starter(id: GraphicsStarterId): GraphicsDocument {
  return GRAPHICS_STARTERS.find((candidate) => candidate.id === id)!.build(FRAME)
}

function ofKind<K extends GraphicsThumbShape['kind']>(shapes: GraphicsThumbShape[], kind: K): Extract<GraphicsThumbShape, { kind: K }>[] {
  return shapes.filter((shape): shape is Extract<GraphicsThumbShape, { kind: K }> => shape.kind === kind)
}

describe('graphics template thumbnails', () => {
  it('draws the TikTok title as a bottom shade under lines stacked in the lower left of the safe area', () => {
    const shapes = graphicsThumbShapes(starter('tiktok-title'))
    expect(shapes[0]).toMatchObject({ kind: 'shade', edge: 'bottom', height: 50, strength: 0.75 })
    const bars = ofKind(shapes, 'bar')
    expect(bars).toHaveLength(3)
    for (const bar of bars) {
      expect(bar.box.left).toBeCloseTo(5, 0)
      expect(bar.box.top + bar.box.height).toBeLessThanOrEqual(78.5)
    }
    expect(bars.map((bar) => bar.box.top)).toEqual([...bars.map((bar) => bar.box.top)].sort((a, b) => a - b))
    expect(bars[1].box.height).toBeGreaterThan(bars[2].box.height)
  })

  it('centres the Headline starter at the top of the safe area under a top shade', () => {
    const shapes = graphicsThumbShapes(starter('headline'))
    expect(shapes[0]).toMatchObject({ kind: 'shade', edge: 'top', height: 35 })
    const [bar] = ofKind(shapes, 'bar')
    expect(bar.box.left + bar.box.width / 2).toBeCloseTo(46.25, 0)
    expect(bar.box.top).toBeGreaterThan(8.5)
    expect(bar.box.top).toBeLessThan(15)
  })

  it('fits a plate to its line, draws QR codes and images where they sit and skips hidden layers', () => {
    const [plate] = ofKind(graphicsThumbShapes(starter('credit')), 'plate')
    expect(plate.box.left).toBeCloseTo(5, 0)
    expect(plate.box.width).toBeLessThan(50)
    const [qr] = ofKind(graphicsThumbShapes(starter('watermark')), 'qr')
    expect(qr.box.left).toBeGreaterThan(50)
    expect(qr.box.top).toBeGreaterThan(50)
    const logo = graphicsDocumentFromLayers([
      { kind: 'image', artifactId: 'logo', size: 0.15, position: { anchor: 'bottom-right', x: 1, y: 1, space: 'safe' } },
      { kind: 'scrim', visible: false },
    ])
    const shapes = graphicsThumbShapes(logo, { logo: { width: 200, height: 100 } })
    expect(shapes).toHaveLength(1)
    const [image] = ofKind(shapes, 'image')
    expect(image).toMatchObject({ artifactId: 'logo' })
    expect(image.box.width).toBeCloseTo(15, 1)
    expect(image.box.height).toBeCloseTo(4.22, 1)
    expect(image.box.left + image.box.width).toBeCloseTo(87.5, 0)
    expect(image.box.top + image.box.height).toBeCloseTo(78, 0)
  })
})
