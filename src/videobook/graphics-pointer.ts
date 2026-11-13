import type { GraphicsEdit } from '../../server/src/graphics/edits'
import { graphicsPlaceBox, graphicsPositionForBox, graphicsSpaceRect, type GraphicsRect } from '../../server/src/graphics/layout'
import {
  GRAPHICS_ANCHOR_POINTS,
  MAX_GRAPHICS_PLATE_PADDING,
  type GraphicsAnchor,
  type GraphicsFrame,
  type GraphicsLayer,
  type GraphicsPosition,
  type GraphicsScrimLayer,
  type GraphicsSpace,
  type GraphicsTextLayer,
} from '../../server/src/graphics/model'

export type GraphicsPoint = { x: number; y: number }
export type GraphicsGuide = { axis: 'x' | 'y'; at: number }
export type GraphicsSnapLines = { x: readonly number[]; y: readonly number[] }
export type GraphicsSnap = { lines: GraphicsSnapLines; threshold: number }
export type GraphicsHandle = 'size' | 'width-start' | 'width-end' | 'height'
export type GraphicsHandlePoint = GraphicsPoint & { handle: GraphicsHandle }
export type GraphicsMove = { position: GraphicsPosition; box: GraphicsRect; guides: GraphicsGuide[] }
export type GraphicsPlacedLayer = Exclude<GraphicsLayer, GraphicsScrimLayer>

type Range = { min: number; max: number }
type WidthHandle = Extract<GraphicsHandle, 'width-start' | 'width-end'>

export type GraphicsResizeInput = {
  frame: GraphicsFrame
  layer: GraphicsLayer
  box: GraphicsRect
  handle: GraphicsHandle
  delta: GraphicsPoint
}

const GUIDE_TOLERANCE = 0.5
const NUDGE_FRACTION = 0.005
const NUDGE_LARGE = 10
const FRACTION_SCALE = 10_000
const TEXT_SIZE: Range = { min: 0.01, max: 0.3 }
const TEXT_WIDTH: Range = { min: 0.1, max: 1 }
const TEXT_GAP: Range = { min: 0, max: 0.1 }
const PLATE_PADDING: Range = { min: 0, max: MAX_GRAPHICS_PLATE_PADDING }
const IMAGE_SIZE: Range = { min: 0.02, max: 1 }
const QR_SIZE: Range = { min: 0.05, max: 0.6 }
const SCRIM_HEIGHT: Range = { min: 0.05, max: 1 }
const ARROWS: Readonly<Record<string, GraphicsPoint>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function within(value: number, range: Range): number {
  return Math.round(clamp(value, range.min, range.max) * FRACTION_SCALE) / FRACTION_SCALE
}

function edges(start: number, size: number): number[] {
  return [start, start + size / 2, start + size]
}

function boxPoint(box: GraphicsRect, at: GraphicsPoint): GraphicsPoint {
  return { x: box.x + at.x * box.width, y: box.y + at.y * box.height }
}

export function graphicsSnapLines(frame: GraphicsFrame, others: readonly GraphicsRect[]): GraphicsSnapLines {
  const safe = graphicsSpaceRect(frame, 'safe')
  const boxes = others.filter((box) => box.width > 0 && box.height > 0)
  return {
    x: [safe.x, safe.x + safe.width, frame.width / 2, ...boxes.flatMap((box) => edges(box.x, box.width))],
    y: [safe.y, safe.y + safe.height, frame.height / 2, ...boxes.flatMap((box) => edges(box.y, box.height))],
  }
}

function snapOffset(start: number, size: number, lines: readonly number[], threshold: number): number {
  let best: number | null = null
  for (const edge of edges(start, size)) {
    for (const line of lines) {
      const offset = line - edge
      if (Math.abs(offset) <= threshold && (best === null || Math.abs(offset) < Math.abs(best))) best = offset
    }
  }
  return best ?? 0
}

function axisGuides(axis: GraphicsGuide['axis'], start: number, size: number, lines: readonly number[]): GraphicsGuide[] {
  const hits = lines.filter((line) => edges(start, size).some((edge) => Math.abs(edge - line) <= GUIDE_TOLERANCE))
  return [...new Set(hits.map((line) => Math.round(line)))].map((at) => ({ axis, at }))
}

export function graphicsMoveLayer(input: {
  frame: GraphicsFrame
  position: GraphicsPosition
  box: GraphicsRect
  delta: GraphicsPoint
  snap: GraphicsSnap | null
}): GraphicsMove {
  const moved = { ...input.box, x: input.box.x + input.delta.x, y: input.box.y + input.delta.y }
  const snap = input.snap
  const snapped = snap
    ? { ...moved, x: moved.x + snapOffset(moved.x, moved.width, snap.lines.x, snap.threshold), y: moved.y + snapOffset(moved.y, moved.height, snap.lines.y, snap.threshold) }
    : moved
  const position = graphicsPositionForBox(input.frame, input.position, snapped)
  const box = graphicsPlaceBox(input.frame, position, snapped)
  const guides = snap ? [...axisGuides('x', box.x, box.width, snap.lines.x), ...axisGuides('y', box.y, box.height, snap.lines.y)] : []
  return { position, box, guides }
}

export function graphicsNudgeStep(frame: GraphicsFrame, large: boolean): number {
  const step = Math.max(1, Math.round(Math.min(frame.width, frame.height) * NUDGE_FRACTION))
  return large ? step * NUDGE_LARGE : step
}

export function graphicsArrowDelta(key: string, frame: GraphicsFrame, large: boolean): GraphicsPoint | null {
  const direction = ARROWS[key]
  if (!direction) return null
  const step = graphicsNudgeStep(frame, large)
  return { x: direction.x * step, y: direction.y * step }
}

export type GraphicsShortcut =
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'duplicate' }
  | { kind: 'delete' }
  | { kind: 'nudge'; delta: GraphicsPoint }

export type GraphicsKeyPress = { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }

export function graphicsShortcut(press: GraphicsKeyPress, frame: GraphicsFrame): GraphicsShortcut | null {
  const command = press.metaKey || press.ctrlKey
  const key = press.key.toLowerCase()
  if (command && !press.altKey) {
    if (key === 'z') return { kind: press.shiftKey ? 'redo' : 'undo' }
    if (key === 'y' && !press.shiftKey) return { kind: 'redo' }
    if (key === 'd' && !press.shiftKey) return { kind: 'duplicate' }
    return null
  }
  if (command || press.altKey) return null
  if (press.key === 'Delete' || press.key === 'Backspace') return { kind: 'delete' }
  const delta = graphicsArrowDelta(press.key, frame, press.shiftKey)
  return delta ? { kind: 'nudge', delta } : null
}

export function graphicsNudgePosition(frame: GraphicsFrame, position: GraphicsPosition, size: { width: number; height: number }, delta: GraphicsPoint): GraphicsPosition {
  const box = graphicsPlaceBox(frame, position, size)
  return graphicsMoveLayer({ frame, position, box, delta, snap: null }).position
}

export function graphicsRepositionEdits(
  frame: GraphicsFrame,
  layer: GraphicsPlacedLayer,
  box: GraphicsRect | null,
  change: { anchor?: GraphicsAnchor; space?: GraphicsSpace },
): GraphicsEdit[] {
  const next = { ...layer.position, ...change }
  const edits: GraphicsEdit[] = [{ op: 'set_position', layer_id: layer.id, position: box ? graphicsPositionForBox(frame, next, box) : next }]
  if (layer.kind !== 'text' || !change.space || change.space === layer.position.space) return edits
  const from = graphicsSpaceRect(frame, layer.position.space).width
  const to = graphicsSpaceRect(frame, change.space).width
  if (!(from > 0 && to > 0)) return edits
  return [...edits, { op: 'set_text_block', layer_id: layer.id, block: { width: within((layer.width * from) / to, TEXT_WIDTH) } }]
}

export function graphicsSizeCorner(anchor: GraphicsAnchor): GraphicsPoint {
  const point = GRAPHICS_ANCHOR_POINTS[anchor]
  return { x: point.x <= 0.5 ? 1 : 0, y: point.y <= 0.5 ? 1 : 0 }
}

export function graphicsWidthHandles(anchor: GraphicsAnchor): WidthHandle[] {
  const x = GRAPHICS_ANCHOR_POINTS[anchor].x
  return [...(x > 0 ? ['width-start' as const] : []), ...(x < 1 ? ['width-end' as const] : [])]
}

function textColumn(layer: GraphicsTextLayer, box: GraphicsRect, width: number): GraphicsRect {
  const anchor = GRAPHICS_ANCHOR_POINTS[layer.position.anchor].x
  return { x: box.x + anchor * box.width - anchor * width, y: box.y, width, height: box.height }
}

export function graphicsTextWidthDrag(frame: GraphicsFrame, layer: GraphicsTextLayer, box: GraphicsRect, handle: WidthHandle, delta: GraphicsPoint): { width: number; column: GraphicsRect } | null {
  const space = graphicsSpaceRect(frame, layer.position.space).width
  const reach = (handle === 'width-start' ? 0 : 1) - GRAPHICS_ANCHOR_POINTS[layer.position.anchor].x
  if (reach === 0 || !(space > 0)) return null
  const width = within((box.width + delta.x / reach) / space, TEXT_WIDTH)
  return { width, column: textColumn(layer, box, width * space) }
}

export function graphicsLayerHandles(layer: GraphicsLayer, box: GraphicsRect): GraphicsHandlePoint[] {
  if (layer.kind === 'scrim') return [{ handle: 'height', x: box.x + box.width / 2, y: layer.edge === 'bottom' ? box.y : box.y + box.height }]
  if (box.width <= 0 || box.height <= 0) return []
  const size: GraphicsHandlePoint = { handle: 'size', ...boxPoint(box, graphicsSizeCorner(layer.position.anchor)) }
  if (layer.kind !== 'text') return [size]
  const middle = box.y + box.height / 2
  return [size, ...graphicsWidthHandles(layer.position.anchor).map((handle) => ({ handle, x: handle === 'width-start' ? box.x : box.x + box.width, y: middle }))]
}

function scaleFactor(box: GraphicsRect, anchor: GraphicsAnchor, delta: GraphicsPoint): number {
  const pivot = boxPoint(box, GRAPHICS_ANCHOR_POINTS[anchor])
  const handle = boxPoint(box, graphicsSizeCorner(anchor))
  const reach = { x: handle.x - pivot.x, y: handle.y - pivot.y }
  const length = reach.x * reach.x + reach.y * reach.y
  if (!(length > 0)) return 1
  return ((handle.x + delta.x - pivot.x) * reach.x + (handle.y + delta.y - pivot.y) * reach.y) / length
}

function textScaleEdits(layer: GraphicsTextLayer, factor: number): GraphicsEdit[] {
  const sizes = layer.items.map((item) => item.size)
  const scale = clamp(factor, Math.max(...sizes.map((size) => TEXT_SIZE.min / size)), Math.min(...sizes.map((size) => TEXT_SIZE.max / size)))
  const plate = layer.plate ? { plate: { paddingX: within(layer.plate.paddingX * scale, PLATE_PADDING), paddingY: within(layer.plate.paddingY * scale, PLATE_PADDING) } } : {}
  return [
    { op: 'set_text_block', layer_id: layer.id, block: { width: within(layer.width * scale, TEXT_WIDTH), gap: within(layer.gap * scale, TEXT_GAP), ...plate } },
    ...layer.items.map((item): GraphicsEdit => ({ op: 'set_item', layer_id: layer.id, item_id: item.id, item: { size: within(item.size * scale, TEXT_SIZE) } })),
  ]
}

function sizeEdits(layer: GraphicsPlacedLayer, factor: number): GraphicsEdit[] {
  if (layer.kind === 'text') return textScaleEdits(layer, factor)
  if (layer.kind === 'image') return [{ op: 'set_image', layer_id: layer.id, image: { size: within(layer.size * factor, IMAGE_SIZE) } }]
  return [{ op: 'set_qr', layer_id: layer.id, qr: { size: within(layer.size * factor, QR_SIZE) } }]
}

function textWidthEdit(frame: GraphicsFrame, layer: GraphicsTextLayer, box: GraphicsRect, handle: WidthHandle, delta: GraphicsPoint): GraphicsEdit[] {
  const drag = graphicsTextWidthDrag(frame, layer, box, handle, delta)
  return drag ? [{ op: 'set_text_block', layer_id: layer.id, block: { width: drag.width } }] : []
}

function scrimHeightEdit(frame: GraphicsFrame, layer: GraphicsScrimLayer, delta: GraphicsPoint): GraphicsEdit[] {
  const change = (layer.edge === 'bottom' ? -delta.y : delta.y) / frame.height
  return [{ op: 'set_scrim', layer_id: layer.id, scrim: { height: within(layer.height + change, SCRIM_HEIGHT) } }]
}

export function graphicsResizeEdits(input: GraphicsResizeInput): GraphicsEdit[] {
  const { frame, layer, box, handle, delta } = input
  if (layer.kind === 'scrim') return handle === 'height' ? scrimHeightEdit(frame, layer, delta) : []
  if (handle === 'size') return sizeEdits(layer, scaleFactor(box, layer.position.anchor, delta))
  if (layer.kind === 'text' && (handle === 'width-start' || handle === 'width-end')) return textWidthEdit(frame, layer, box, handle, delta)
  return []
}

export function graphicsFocusPoint(point: GraphicsPoint, bounds: { left: number; top: number; width: number; height: number }): GraphicsPoint {
  return { x: clamp((point.x - bounds.left) / Math.max(1, bounds.width), 0, 1), y: clamp((point.y - bounds.top) / Math.max(1, bounds.height), 0, 1) }
}
