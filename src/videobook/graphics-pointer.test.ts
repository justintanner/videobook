import { describe, expect, it } from 'vitest'
import { applyGraphicsEdits, type GraphicsEdit } from '../../server/src/graphics/edits'
import { graphicsSpaceRect, layoutGraphics, type GraphicsMeasure, type GraphicsRect } from '../../server/src/graphics/layout'
import {
  GRAPHICS_ANCHORS,
  graphicsDocumentFromLayers,
  type GraphicsDocument,
  type GraphicsFrame,
  type GraphicsImageLayer,
  type GraphicsLayer,
  type GraphicsQrLayer,
  type GraphicsScrimLayer,
  type GraphicsTextLayer,
} from '../../server/src/graphics/model'
import {
  graphicsArrowDelta,
  graphicsLayerHandles,
  graphicsMoveLayer,
  graphicsNudgePosition,
  graphicsNudgeStep,
  graphicsRepositionEdits,
  graphicsResizeEdits,
  graphicsShortcut,
  graphicsSizeCorner,
  graphicsSnapLines,
  graphicsTextWidthDrag,
  graphicsWidthHandles,
  type GraphicsHandle,
  type GraphicsMove,
  type GraphicsPoint,
} from './graphics-pointer'

const PORTRAIT: GraphicsFrame = { width: 720, height: 1280 }
const SQUARE: GraphicsFrame = { width: 720, height: 720 }
const LANDSCAPE: GraphicsFrame = { width: 1280, height: 720 }
const FRAMES = [PORTRAIT, SQUARE, LANDSCAPE]
const measure: GraphicsMeasure = (text, font) => Array.from(text).length * font.size * 0.5
const IMAGES = { logo: { width: 200, height: 100 } }

function sample(): GraphicsDocument {
  return graphicsDocumentFromLayers([
    { kind: 'scrim', edge: 'bottom', height: 0.4 },
    { kind: 'text', name: 'Title', position: { anchor: 'bottom-left', x: 0, y: 1, space: 'safe' }, width: 0.8, align: 'left', items: [{ text: 'Red light legends', size: 0.08 }, { text: 'Second line', size: 0.04 }] },
    { kind: 'image', name: 'Logo', artifactId: 'logo', size: 0.2 },
    { kind: 'qr', name: 'QR', url: 'https://example.com/a', slot: null, size: 0.16 },
  ])
}

function boxes(document: GraphicsDocument, frame: GraphicsFrame): Map<string, GraphicsRect> {
  return new Map(layoutGraphics({ document, frame, measure, images: IMAGES }).map((entry) => [entry.layerId, entry.box]))
}

function layerNamed<K extends GraphicsLayer['kind']>(document: GraphicsDocument, kind: K): Extract<GraphicsLayer, { kind: K }> {
  return document.layers.find((layer) => layer.kind === kind) as Extract<GraphicsLayer, { kind: K }>
}

function applied(document: GraphicsDocument, edits: GraphicsEdit[]): GraphicsDocument {
  const result = applyGraphicsEdits(document, edits)
  if (!result.ok) throw new Error(result.error.message)
  return result.document
}

function moveTo(document: GraphicsDocument, frame: GraphicsFrame, layerId: string, delta: GraphicsPoint, snap = false) {
  const layer = document.layers.find((entry) => entry.id === layerId)
  if (!layer || layer.kind === 'scrim') throw new Error('placed layer expected')
  const box = boxes(document, frame).get(layerId)!
  const others = [...boxes(document, frame)].filter(([id]) => id !== layerId && document.layers.find((entry) => entry.id === id)?.kind !== 'scrim').map(([, rect]) => rect)
  const move = graphicsMoveLayer({ frame, position: layer.position, box, delta, snap: snap ? { lines: graphicsSnapLines(frame, others), threshold: 12 } : null })
  return { move, box, document: applied(document, [{ op: 'set_position', layer_id: layerId, position: move.position }]) }
}

describe('graphicsMoveLayer', () => {
  it.each(FRAMES)('puts every kind of layer where the pointer moved it at %j, keeping its anchor', (frame) => {
    const document = sample()
    for (const layer of document.layers) {
      if (layer.kind === 'scrim') continue
      const start = boxes(document, frame).get(layer.id)!
      const delta = { x: start.x + start.width / 2 < frame.width / 2 ? 37 : -37, y: start.y + start.height / 2 < frame.height / 2 ? 61 : -61 }
      const { move, document: moved } = moveTo(document, frame, layer.id, delta)
      const after = boxes(moved, frame).get(layer.id)!
      expect(Math.abs(after.x - (start.x + delta.x))).toBeLessThanOrEqual(1)
      expect(Math.abs(after.y - (start.y + delta.y))).toBeLessThanOrEqual(1)
      expect(after.width).toBe(start.width)
      expect(move.position.anchor).toBe(layer.position.anchor)
      expect(move.guides).toEqual([])
    }
  })

  it('stops at the edge of the positioning space', () => {
    const document = sample()
    const title = layerNamed(document, 'text')
    const { move, document: moved } = moveTo(document, PORTRAIT, title.id, { x: -400, y: 900 })
    const safe = graphicsSpaceRect(PORTRAIT, 'safe')
    const after = boxes(moved, PORTRAIT).get(title.id)!
    expect(move.position).toMatchObject({ anchor: 'bottom-left', x: 0, y: 1, space: 'safe' })
    expect(after.x).toBe(safe.x)
    expect(after.y + after.height).toBe(safe.y + safe.height)
  })

  it.each(FRAMES)('snaps the centre of a box to the frame centre lines near them at %j', (frame) => {
    const document = graphicsDocumentFromLayers([{ kind: 'image', name: 'Logo', artifactId: 'logo', size: 0.2 }])
    const logo = layerNamed(document, 'image')
    const box = boxes(document, frame).get(logo.id)!
    const near = { x: frame.width / 2 - (box.x + box.width / 2) + 7, y: frame.height / 2 - (box.y + box.height / 2) - 9 }
    const { move, document: moved } = moveTo(document, frame, logo.id, near, true)
    const after = boxes(moved, frame).get(logo.id)!
    expect(Math.abs(after.x + after.width / 2 - frame.width / 2)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.y + after.height / 2 - frame.height / 2)).toBeLessThanOrEqual(1)
    expect(move.guides).toEqual([{ axis: 'x', at: frame.width / 2 }, { axis: 'y', at: frame.height / 2 }])
    const free = moveTo(document, frame, logo.id, near, false)
    expect(free.move.box.x + free.move.box.width / 2 - frame.width / 2).toBeCloseTo(7, 1)
    expect(free.move.guides).toEqual([])
  })

  describe('snap targets', () => {
    const other = { x: 500, y: 300, width: 100, height: 50 }
    const start = { x: 100, y: 800, width: 80, height: 40 }
    const position = { anchor: 'top-left' as const, x: 100 / 720, y: 800 / 1280, space: 'frame' as const }
    const snap = { lines: graphicsSnapLines(PORTRAIT, [other]), threshold: 12 }
    const move = (delta: GraphicsPoint, active = true) => graphicsMoveLayer({ frame: PORTRAIT, position, box: start, delta, snap: active ? snap : null })
    const placed = (result: GraphicsMove) => ({ x: Math.round(result.box.x * 100) / 100, y: Math.round(result.box.y * 100) / 100, guides: result.guides })

    it('lists the safe-area edges, the centre lines and the edges and centres of the other layers', () => {
      expect(snap.lines.x).toEqual([36, 630, 360, 500, 550, 600])
      expect(snap.lines.y).toEqual([109, 998, 640, 300, 325, 350])
    })

    it('pulls the nearest edge onto a line within the threshold and reports the guide', () => {
      expect(placed(move({ x: 395, y: 0 }))).toEqual({ x: 500, y: 800, guides: [{ axis: 'x', at: 500 }] })
      expect(placed(move({ x: -60, y: 0 }))).toEqual({ x: 36, y: 800, guides: [{ axis: 'x', at: 36 }] })
      const centred = move({ x: 227, y: -175 })
      expect(centred.box.x + centred.box.width / 2).toBeCloseTo(360, 1)
      expect(centred.box.y + centred.box.height / 2).toBeCloseTo(640, 1)
      expect(centred.guides).toEqual([{ axis: 'x', at: 360 }, { axis: 'y', at: 640 }])
    })

    it('leaves a box alone beyond the threshold or when snapping is off', () => {
      expect(placed(move({ x: 385, y: 0 }))).toEqual({ x: 485, y: 800, guides: [] })
      expect(placed(move({ x: 395, y: 0 }, false))).toEqual({ x: 495, y: 800, guides: [] })
    })

    it('ignores empty boxes as targets', () => {
      const lines = graphicsSnapLines(PORTRAIT, [{ x: 100, y: 100, width: 0, height: 0 }])
      expect(lines.x).toEqual([36, 630, 360])
    })
  })
})

describe('keyboard nudges', () => {
  it('steps half a percent of the short side, ten times with shift', () => {
    expect(graphicsNudgeStep(PORTRAIT, false)).toBe(4)
    expect(graphicsNudgeStep({ width: 1920, height: 1080 }, false)).toBe(5)
    expect(graphicsNudgeStep({ width: 100, height: 60 }, false)).toBe(1)
    expect(graphicsNudgeStep(PORTRAIT, true)).toBe(40)
    expect(graphicsArrowDelta('ArrowLeft', PORTRAIT, false)).toEqual({ x: -4, y: 0 })
    expect(graphicsArrowDelta('ArrowDown', PORTRAIT, true)).toEqual({ x: 0, y: 40 })
    expect(graphicsArrowDelta('Enter', PORTRAIT, false)).toBeNull()
  })

  it('maps keys to undo, redo, duplicate, delete and nudges', () => {
    const press = (key: string, keys: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => graphicsShortcut({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...keys }, PORTRAIT)
    expect(press('z', { metaKey: true })).toEqual({ kind: 'undo' })
    expect(press('Z', { ctrlKey: true, shiftKey: true })).toEqual({ kind: 'redo' })
    expect(press('y', { ctrlKey: true })).toEqual({ kind: 'redo' })
    expect(press('d', { metaKey: true })).toEqual({ kind: 'duplicate' })
    expect(press('Delete')).toEqual({ kind: 'delete' })
    expect(press('Backspace')).toEqual({ kind: 'delete' })
    expect(press('ArrowRight')).toEqual({ kind: 'nudge', delta: { x: 4, y: 0 } })
    expect(press('ArrowUp', { shiftKey: true })).toEqual({ kind: 'nudge', delta: { x: 0, y: -40 } })
    expect(press('ArrowUp', { altKey: true })).toBeNull()
    expect(press('Backspace', { metaKey: true })).toBeNull()
    expect(press('z', { metaKey: true, altKey: true })).toBeNull()
    expect(press('d')).toBeNull()
  })

  it('accumulates nudges from the document position and stops at the space edge', () => {
    const document = sample()
    const logo = layerNamed(document, 'image')
    const size = boxes(document, PORTRAIT).get(logo.id)!
    let position = logo.position
    for (let step = 0; step < 5; step += 1) position = graphicsNudgePosition(PORTRAIT, position, size, { x: 8, y: 4 })
    const moved = applied(document, [{ op: 'set_position', layer_id: logo.id, position }])
    const after = boxes(moved, PORTRAIT).get(logo.id)!
    expect(after.x - size.x).toBe(40)
    expect(after.y - size.y).toBe(20)
    const back = graphicsNudgePosition(PORTRAIT, position, size, { x: -500, y: -500 })
    expect(back).toMatchObject({ x: 0, y: 0 })
  })
})

describe('anchor and space changes', () => {
  it.each(GRAPHICS_ANCHORS)('keeps the layer in place when the anchor becomes %s', (anchor) => {
    const document = sample()
    const title = layerNamed(document, 'text')
    const before = boxes(document, PORTRAIT).get(title.id)!
    const moved = applied(document, graphicsRepositionEdits(PORTRAIT, title, before, { anchor }))
    const after = boxes(moved, PORTRAIT).get(title.id)!
    expect(layerNamed(moved, 'text').position.anchor).toBe(anchor)
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1)
  })

  it('keeps the layer in place when its space changes, and falls back to a plain change without a box', () => {
    const document = sample()
    const qr = layerNamed(document, 'qr')
    const before = boxes(document, LANDSCAPE).get(qr.id)!
    for (const space of ['frame', 'inset'] as const) {
      const moved = applied(document, graphicsRepositionEdits(LANDSCAPE, qr, before, { space }))
      const after = boxes(moved, LANDSCAPE).get(qr.id)!
      expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeLessThanOrEqual(1)
    }
    const safe = graphicsSpaceRect(LANDSCAPE, 'safe')
    const inside = boxes(applied(document, graphicsRepositionEdits(LANDSCAPE, qr, before, { space: 'safe' })), LANDSCAPE).get(qr.id)!
    expect(inside.x + inside.width).toBe(safe.x + safe.width)
    expect(inside.y + inside.height).toBe(safe.y + safe.height)
    expect(graphicsRepositionEdits(LANDSCAPE, qr, null, { space: 'frame' })).toEqual([{ op: 'set_position', layer_id: qr.id, position: { ...qr.position, space: 'frame' } }])
  })

  it('keeps the wrap width of a text block in pixels when its space changes, so its lines stay the same', () => {
    const document = sample()
    const title = layerNamed(document, 'text')
    const before = boxes(document, PORTRAIT).get(title.id)!
    const edits = graphicsRepositionEdits(PORTRAIT, title, before, { space: 'frame' })
    const moved = applied(document, edits)
    expect(layerNamed(moved, 'text').width).toBeCloseTo((0.8 * graphicsSpaceRect(PORTRAIT, 'safe').width) / PORTRAIT.width, 4)
    const after = boxes(moved, PORTRAIT).get(title.id)!
    expect(after).toEqual(before)
    expect(graphicsRepositionEdits(PORTRAIT, title, before, { anchor: 'center' })).toHaveLength(1)
    const wide = applied(document, [{ op: 'set_text_block', layer_id: title.id, block: { width: 0.95 } }, { op: 'set_position', layer_id: title.id, position: { space: 'frame' } }])
    const narrowed = graphicsRepositionEdits(PORTRAIT, layerNamed(wide, 'text'), boxes(wide, PORTRAIT).get(title.id)!, { space: 'safe' })
    expect(narrowed[1]).toEqual({ op: 'set_text_block', layer_id: title.id, block: { width: 1 } })
  })
})

describe('handles', () => {
  it('puts the size handle on the corner away from the anchor and width handles where the column can move', () => {
    expect(graphicsSizeCorner('top-left')).toEqual({ x: 1, y: 1 })
    expect(graphicsSizeCorner('center')).toEqual({ x: 1, y: 1 })
    expect(graphicsSizeCorner('bottom-left')).toEqual({ x: 1, y: 0 })
    expect(graphicsSizeCorner('bottom-right')).toEqual({ x: 0, y: 0 })
    expect(graphicsWidthHandles('left')).toEqual(['width-end'])
    expect(graphicsWidthHandles('top')).toEqual(['width-start', 'width-end'])
    expect(graphicsWidthHandles('bottom-right')).toEqual(['width-start'])
  })

  it('lists the handles of each kind at their pixel points, all on the box', () => {
    const document = sample()
    const layout = boxes(document, PORTRAIT)
    const title = layerNamed(document, 'text')
    const titleBox = layout.get(title.id)!
    expect(graphicsLayerHandles(title, titleBox)).toEqual([
      { handle: 'size', x: titleBox.x + titleBox.width, y: titleBox.y },
      { handle: 'width-end', x: titleBox.x + titleBox.width, y: titleBox.y + titleBox.height / 2 },
    ])
    const scrim = layerNamed(document, 'scrim')
    const scrimBox = layout.get(scrim.id)!
    expect(graphicsLayerHandles(scrim, scrimBox)).toEqual([{ handle: 'height', x: PORTRAIT.width / 2, y: scrimBox.y }])
    expect(graphicsLayerHandles(layerNamed(document, 'qr'), { x: 5, y: 5, width: 0, height: 0 })).toEqual([])
  })
})

describe('graphicsResizeEdits', () => {
  function resize(document: GraphicsDocument, frame: GraphicsFrame, layerId: string, handle: GraphicsHandle, delta: GraphicsPoint): GraphicsDocument {
    const layer = document.layers.find((entry) => entry.id === layerId)!
    const box = boxes(document, frame).get(layerId)!
    return applied(document, graphicsResizeEdits({ frame, layer, box, handle, delta }))
  }

  it('grows an image from its anchor so the size handle follows the pointer', () => {
    const document = sample()
    const logo = layerNamed(document, 'image')
    const before = boxes(document, PORTRAIT).get(logo.id)!
    const grown = resize(document, PORTRAIT, logo.id, 'size', { x: 72, y: 36 })
    const after = boxes(grown, PORTRAIT).get(logo.id)!
    expect((layerNamed(grown, 'image') as GraphicsImageLayer).size).toBeCloseTo(0.3, 4)
    expect(after.x).toBe(before.x)
    expect(after.y).toBe(before.y)
    expect(after.width).toBe(before.width + 72)
  })

  it('shrinks a bottom-right QR code from its top-left handle and stops at the schema limits', () => {
    const document = sample()
    const qr = layerNamed(document, 'qr')
    const before = boxes(document, PORTRAIT).get(qr.id)!
    const shrunk = resize(document, PORTRAIT, qr.id, 'size', { x: 30, y: 30 })
    const after = boxes(shrunk, PORTRAIT).get(qr.id)!
    expect(after.x + after.width).toBe(before.x + before.width)
    expect(after.width).toBeLessThan(before.width)
    expect((layerNamed(resize(document, PORTRAIT, qr.id, 'size', { x: 5000, y: 5000 }), 'qr') as GraphicsQrLayer).size).toBe(0.05)
    expect((layerNamed(resize(document, PORTRAIT, qr.id, 'size', { x: -5000, y: -5000 }), 'qr') as GraphicsQrLayer).size).toBe(0.6)
  })

  it('scales a whole text block with its corner handle and keeps the item ratios', () => {
    const document = applied(sample(), [{ op: 'set_text_block', layer_id: 'l2', block: { plate: { paddingX: 0.02, paddingY: 0.01 } } }])
    const title = layerNamed(document, 'text')
    const before = boxes(document, PORTRAIT).get(title.id)!
    const scaled = layerNamed(resize(document, PORTRAIT, title.id, 'size', { x: before.width / 2, y: -before.height / 2 }), 'text') as GraphicsTextLayer
    expect(scaled.items.map((item) => item.size)).toEqual([0.12, 0.06])
    expect(scaled.width).toBe(1)
    expect(scaled.gap).toBeCloseTo(title.gap * 1.5, 4)
    expect(scaled.plate).toMatchObject({ paddingX: 0.03, paddingY: 0.015 })
    const tiny = layerNamed(resize(document, PORTRAIT, title.id, 'size', { x: -5000, y: 5000 }), 'text') as GraphicsTextLayer
    expect(tiny.items[1]!.size).toBe(0.01)
    expect(tiny.items[0]!.size).toBe(0.02)
    const huge = layerNamed(resize(document, PORTRAIT, title.id, 'size', { x: 50_000, y: -50_000 }), 'text') as GraphicsTextLayer
    expect(huge.items[0]!.size).toBe(0.3)
    expect(huge.items[1]!.size).toBe(0.15)
  })

  it('sets the wrap width from the box edge the pointer drags, twice as far from a centred anchor', () => {
    const document = sample()
    const title = layerNamed(document, 'text')
    const space = graphicsSpaceRect(PORTRAIT, 'safe').width
    const box = boxes(document, PORTRAIT).get(title.id)!
    const drag = graphicsTextWidthDrag(PORTRAIT, title, box, 'width-end', { x: -60, y: 40 })!
    expect(drag.width).toBeCloseTo((box.width - 60) / space, 4)
    expect(drag.column.x).toBe(box.x)
    expect(drag.column.x + drag.column.width).toBeCloseTo(box.x + box.width - 60, 1)
    const narrower = layerNamed(resize(document, PORTRAIT, title.id, 'width-end', { x: -60, y: 40 }), 'text') as GraphicsTextLayer
    expect(narrower.width).toBe(drag.width)
    const after = boxes(applied(document, [{ op: 'set_text_block', layer_id: title.id, block: { width: drag.width } }]), PORTRAIT).get(title.id)!
    expect(after.width).toBeLessThanOrEqual(box.width - 60 + 1)
    expect(after.width).toBeLessThan(box.width)
    const centred = applied(document, [{ op: 'set_position', layer_id: title.id, position: { anchor: 'center', x: 0.5, y: 0.5 } }])
    const centredBox = boxes(centred, PORTRAIT).get(title.id)!
    const fromStart = graphicsTextWidthDrag(PORTRAIT, layerNamed(centred, 'text'), centredBox, 'width-start', { x: 30, y: 0 })!
    expect(fromStart.width).toBeCloseTo((centredBox.width - 60) / space, 4)
    expect(fromStart.column.x).toBeCloseTo(centredBox.x + 30, 1)
    expect(fromStart.column.x + fromStart.column.width).toBeCloseTo(centredBox.x + centredBox.width - 30, 1)
    const floor = layerNamed(resize(document, PORTRAIT, title.id, 'width-end', { x: -5000, y: 0 }), 'text') as GraphicsTextLayer
    expect(floor.width).toBe(0.1)
    const ceiling = layerNamed(resize(document, PORTRAIT, title.id, 'width-end', { x: 5000, y: 0 }), 'text') as GraphicsTextLayer
    expect(ceiling.width).toBe(1)
    expect(graphicsTextWidthDrag(PORTRAIT, title, box, 'width-start', { x: 10, y: 0 })).toBeNull()
    expect(graphicsResizeEdits({ frame: PORTRAIT, layer: title, box, handle: 'width-start', delta: { x: 10, y: 0 } })).toEqual([])
  })

  it('drags the inner edge of a shade for its height', () => {
    const document = applied(sample(), [{ op: 'add_layer', layer: { kind: 'scrim', edge: 'top', height: 0.2 } }])
    const [bottom, top] = document.layers.filter((layer): layer is GraphicsScrimLayer => layer.kind === 'scrim')
    expect((resize(document, PORTRAIT, bottom!.id, 'height', { x: 99, y: -128 }).layers.find((layer) => layer.id === bottom!.id) as GraphicsScrimLayer).height).toBeCloseTo(0.5, 4)
    expect((resize(document, PORTRAIT, top!.id, 'height', { x: 0, y: 128 }).layers.find((layer) => layer.id === top!.id) as GraphicsScrimLayer).height).toBeCloseTo(0.3, 4)
    expect((resize(document, PORTRAIT, top!.id, 'height', { x: 0, y: -5000 }).layers.find((layer) => layer.id === top!.id) as GraphicsScrimLayer).height).toBe(0.05)
    expect(graphicsResizeEdits({ frame: PORTRAIT, layer: top!, box: { x: 0, y: 0, width: 720, height: 256 }, handle: 'size', delta: { x: 0, y: 10 } })).toEqual([])
  })
})
