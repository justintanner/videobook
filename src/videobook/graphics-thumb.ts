import { graphicsPlaceBox, graphicsSpaceRect, type GraphicsRect } from '../../server/src/graphics/layout'
import type {
  GraphicsDocument,
  GraphicsImageLayer,
  GraphicsLayer,
  GraphicsQrLayer,
  GraphicsScrimLayer,
  GraphicsTextItem,
  GraphicsTextLayer,
} from '../../server/src/graphics/model'

export type GraphicsThumbBox = { left: number; top: number; width: number; height: number }

export type GraphicsThumbShape =
  | { kind: 'shade'; key: string; edge: 'top' | 'bottom'; height: number; strength: number; color: string }
  | { kind: 'plate'; key: string; box: GraphicsThumbBox; color: string; opacity: number }
  | { kind: 'bar'; key: string; box: GraphicsThumbBox; color: string }
  | { kind: 'image'; key: string; box: GraphicsThumbBox; artifactId: string }
  | { kind: 'qr'; key: string; box: GraphicsThumbBox; dark: string; light: string }

export type GraphicsThumbImages = Readonly<Record<string, { width: number | null; height: number | null }>>

const FRAME = { width: 1080, height: 1920 }
const SHORT_SIDE = Math.min(FRAME.width, FRAME.height)
const LINE_HEIGHT = 1.25
const BAR_HEIGHT = 0.6
const CHARACTER_WIDTH = 0.55
const SLOT_WIDTHS: Readonly<Record<string, number>> = { headline: 0.92, secondary: 0.7, credit: 0.5, handle: 0.42 }
const TEXT_WIDTH = 0.8

function percentBox(rect: GraphicsRect): GraphicsThumbBox {
  return {
    left: (rect.x / FRAME.width) * 100,
    top: (rect.y / FRAME.height) * 100,
    width: (rect.width / FRAME.width) * 100,
    height: (rect.height / FRAME.height) * 100,
  }
}

function itemWidth(item: GraphicsTextItem, room: number): number {
  const typed = item.text.trim()
  if (!typed) return (SLOT_WIDTHS[item.slot ?? ''] ?? TEXT_WIDTH) * room
  const estimate = Array.from(typed).length * item.size * SHORT_SIDE * CHARACTER_WIDTH
  return Math.min(room, Math.max(item.size * SHORT_SIDE, estimate))
}

function alignedX(align: GraphicsTextLayer['align'], start: number, room: number, width: number): number {
  if (align === 'left') return start
  if (align === 'right') return start + room - width
  return start + (room - width) / 2
}

type ThumbLine = { item: GraphicsTextItem; height: number; width: number; top: number }

function stackLines(layer: GraphicsTextLayer, room: number): ThumbLine[] {
  const gap = layer.gap * SHORT_SIDE
  return layer.items.reduce<ThumbLine[]>((lines, item) => {
    const previous = lines.at(-1)
    const top = previous ? previous.top + previous.height + gap : 0
    return [...lines, { item, height: item.size * SHORT_SIDE * LINE_HEIGHT, width: itemWidth(item, room), top }]
  }, [])
}

function barShape(layer: GraphicsTextLayer, line: ThumbLine, origin: { x: number; y: number }, room: number): GraphicsThumbShape {
  const barHeight = line.item.size * SHORT_SIDE * BAR_HEIGHT
  const rect = { x: alignedX(layer.align, origin.x, room, line.width), y: origin.y + line.top + (line.height - barHeight) / 2, width: line.width, height: barHeight }
  return { kind: 'bar', key: `${layer.id}:${line.item.id}`, box: percentBox(rect), color: line.item.color }
}

function textShapes(layer: GraphicsTextLayer): GraphicsThumbShape[] {
  const space = graphicsSpaceRect(FRAME, layer.position.space)
  const padX = (layer.plate?.paddingX ?? 0) * SHORT_SIDE
  const padY = (layer.plate?.paddingY ?? 0) * SHORT_SIDE
  const blockWidth = layer.width * space.width
  const lines = stackLines(layer, Math.max(1, blockWidth - 2 * padX))
  const last = lines.at(-1)
  const height = (last ? last.top + last.height : 0) + 2 * padY
  const widest = Math.max(0, ...lines.map((line) => line.width))
  const box = graphicsPlaceBox(FRAME, layer.position, { width: layer.plate ? widest + 2 * padX : blockWidth, height })
  const origin = { x: box.x + padX, y: box.y + padY }
  const bars = lines.map((line) => barShape(layer, line, origin, box.width - 2 * padX))
  if (!layer.plate) return bars
  return [{ kind: 'plate', key: `${layer.id}:plate`, box: percentBox(box), color: layer.plate.color, opacity: layer.plate.opacity }, ...bars]
}

function imageShape(layer: GraphicsImageLayer, images: GraphicsThumbImages): GraphicsThumbShape {
  const image = images[layer.artifactId]
  const width = layer.size * SHORT_SIDE
  const ratio = image?.width && image.height ? image.height / image.width : 1
  const box = graphicsPlaceBox(FRAME, layer.position, { width, height: width * ratio })
  return { kind: 'image', key: layer.id, box: percentBox(box), artifactId: layer.artifactId }
}

function qrShape(layer: GraphicsQrLayer): GraphicsThumbShape {
  const side = layer.size * SHORT_SIDE
  return { kind: 'qr', key: layer.id, box: percentBox(graphicsPlaceBox(FRAME, layer.position, { width: side, height: side })), dark: layer.dark, light: layer.light }
}

function shadeShape(layer: GraphicsScrimLayer): GraphicsThumbShape {
  return { kind: 'shade', key: layer.id, edge: layer.edge, height: layer.height * 100, strength: layer.strength, color: layer.color }
}

function layerShapes(layer: GraphicsLayer, images: GraphicsThumbImages): GraphicsThumbShape[] {
  if (!layer.visible) return []
  if (layer.kind === 'text') return textShapes(layer)
  if (layer.kind === 'image') return [imageShape(layer, images)]
  if (layer.kind === 'qr') return [qrShape(layer)]
  return [shadeShape(layer)]
}

export function graphicsThumbShapes(document: GraphicsDocument, images: GraphicsThumbImages = {}): GraphicsThumbShape[] {
  return document.layers.flatMap((layer) => layerShapes(layer, images))
}
