import { CAPTION_SAFE_ZONES } from "../captions/layout.js";
import type { CaptionAspect } from "../captions/model.js";
import { CAPTION_ASPECT_SIZES, CAPTION_ASPECTS } from "../captions/model.js";
import { captionCase, isUnspacedText } from "../captions/script.js";
import { splitUnspacedText } from "../transcript-words.js";
import type { GraphicsFontFace } from "./fonts.js";
import { graphicsLineMetrics, graphicsPresetFont } from "./fonts.js";
import type {
  GraphicsAccent,
  GraphicsDocument,
  GraphicsFrame,
  GraphicsImageLayer,
  GraphicsLayer,
  GraphicsPosition,
  GraphicsQrLayer,
  GraphicsScrimLayer,
  GraphicsSpace,
  GraphicsTextItem,
  GraphicsTextLayer,
} from "./model.js";
import { GRAPHICS_ANCHOR_POINTS, GRAPHICS_INSET_FRACTION, graphicsFrame } from "./model.js";

export type GraphicsRect = { x: number; y: number; width: number; height: number };
export type GraphicsRoundedRect = GraphicsRect & { radius: number };
export type GraphicsFontSpec = GraphicsFontFace & { size: number };
export type GraphicsMeasure = (text: string, font: GraphicsFontSpec) => number;
export type GraphicsImageSize = { width: number; height: number };
export type GraphicsImageSizes = Readonly<Partial<Record<string, GraphicsImageSize>>>;
export type GraphicsTextLine = GraphicsRect & { text: string; baseline: number };

export type GraphicsTextItemLayout = {
  itemId: string;
  font: GraphicsFontSpec;
  box: GraphicsRect;
  lines: GraphicsTextLine[];
  icon: GraphicsRect | null;
  accent: GraphicsRect | null;
  overflow: boolean;
};

export type GraphicsTextLayout = {
  kind: "text";
  layerId: string;
  box: GraphicsRect;
  plate: GraphicsRoundedRect | null;
  items: GraphicsTextItemLayout[];
  overflow: boolean;
};

export type GraphicsImageLayout = { kind: "image"; layerId: string; box: GraphicsRect; missing: boolean };

export type GraphicsQrLayout = {
  kind: "qr";
  layerId: string;
  box: GraphicsRect;
  tile: GraphicsRoundedRect | null;
  modules: GraphicsRect;
};

export type GraphicsScrimLayout = { kind: "scrim"; layerId: string; box: GraphicsRect };

export type GraphicsLayerLayout = GraphicsTextLayout | GraphicsImageLayout | GraphicsQrLayout | GraphicsScrimLayout;

export type GraphicsLayoutInput = {
  document: GraphicsDocument;
  frame: GraphicsFrame;
  measure: GraphicsMeasure;
  images?: GraphicsImageSizes;
};

type Size = { width: number; height: number };
type LayoutContext = { frame: GraphicsFrame; short: number; measure: GraphicsMeasure; images: GraphicsImageSizes };
type WrapUnit = { text: string; space: string };
type FittedLine = { text: string; width: number };
type FittedItem = { item: GraphicsTextItem; font: GraphicsFontSpec; lines: FittedLine[]; overflow: boolean };
type ItemAccent = { gap: number; height: number };

type PlannedItem = FittedItem & {
  ascent: number;
  lineHeight: number;
  icon: number;
  iconSpace: number;
  accent: ItemAccent | null;
  width: number;
  height: number;
};

const SHRINK_STEP = 0.92;
const MIN_FONT_SCALE = 0.6;
const FIT_SLACK = 0.99;
const ICON_SCALE = 26 / 28;
const ICON_GAP_SCALE = 0.5;
const ACCENT_GAP_SCALE = 0.06;
const ACCENT_HEIGHT_SCALE: Record<Exclude<GraphicsAccent, "none">, number> = { underline: 0.07, brush: 0.16 };
const QR_TILE_PADDING = 0.1;
const QR_TILE_RADIUS = 1 / 12;
const SIZE_EPSILON = 1e-6;
const POSITION_SCALE = 100_000;
const SPACE_RUN = /([ \t]*)([^ \t]+)/gu;
const ALIGN_FRACTIONS: Record<GraphicsTextLayer["align"], number> = { left: 0, center: 0.5, right: 1 };

function px(value: number): number {
  return Math.round(value) || 0;
}

function pixelRect(rect: GraphicsRect): GraphicsRect {
  const x = px(rect.x);
  const y = px(rect.y);
  return { x, y, width: px(rect.x + rect.width) - x, height: px(rect.y + rect.height) - y };
}

function roundedRect(rect: GraphicsRect, radius: number): GraphicsRoundedRect {
  return { ...pixelRect(rect), radius: Math.round(radius * 100) / 100 };
}

function aspectDistance(aspect: CaptionAspect, ratio: number): number {
  const size = CAPTION_ASPECT_SIZES[aspect];
  return Math.abs(Math.log(size.width / size.height) - ratio);
}

function nearestCaptionAspect(frame: GraphicsFrame): CaptionAspect {
  const ratio = Math.log(frame.width / frame.height);
  return CAPTION_ASPECTS.reduce<CaptionAspect>(
    (best, aspect) => (aspectDistance(aspect, ratio) < aspectDistance(best, ratio) ? aspect : best),
    CAPTION_ASPECTS[0],
  );
}

function insetRect(frame: GraphicsFrame, pad: number): GraphicsRect {
  const inset = Math.min(pad, frame.width / 2, frame.height / 2);
  return { x: inset, y: inset, width: frame.width - 2 * inset, height: frame.height - 2 * inset };
}

function spaceRect(frame: GraphicsFrame, space: GraphicsSpace): GraphicsRect {
  if (space === "frame") return { x: 0, y: 0, width: frame.width, height: frame.height };
  if (space === "inset") return insetRect(frame, frame.width * GRAPHICS_INSET_FRACTION);
  const zone = CAPTION_SAFE_ZONES[nearestCaptionAspect(frame)];
  return {
    x: zone.left * frame.width,
    y: zone.top * frame.height,
    width: frame.width * (1 - zone.left - zone.right),
    height: frame.height * (1 - zone.top - zone.bottom),
  };
}

export function graphicsSpaceRect(frame: GraphicsFrame, space: GraphicsSpace): GraphicsRect {
  return pixelRect(spaceRect(graphicsFrame(frame), space));
}

function alignedStart(start: number, extent: number, at: number, anchor: number, size: number): number {
  if (size > extent + SIZE_EPSILON) return start + (extent - size) / 2;
  return Math.min(Math.max(start, start + at * extent - anchor * size), start + extent - size);
}

function placeBox(space: GraphicsRect, position: GraphicsPosition, size: Size): GraphicsRect {
  const anchor = GRAPHICS_ANCHOR_POINTS[position.anchor];
  return {
    x: alignedStart(space.x, space.width, position.x, anchor.x, size.width),
    y: alignedStart(space.y, space.height, position.y, anchor.y, size.height),
    width: size.width,
    height: size.height,
  };
}

export function graphicsPlaceBox(frame: GraphicsFrame, position: GraphicsPosition, size: { width: number; height: number }): GraphicsRect {
  return placeBox(spaceRect(graphicsFrame(frame), position.space), position, size);
}

function anchorFraction(start: number, extent: number, at: number, anchor: number, size: number, current: number): number {
  if (!(extent > 0) || size > extent + SIZE_EPSILON) return current;
  const placed = Math.min(Math.max(at, start), start + extent - size);
  const fraction = Math.min(1, Math.max(0, (placed - start + anchor * size) / extent));
  return Math.round(fraction * POSITION_SCALE) / POSITION_SCALE;
}

export function graphicsPositionForBox(frame: GraphicsFrame, position: GraphicsPosition, box: GraphicsRect): GraphicsPosition {
  const space = spaceRect(graphicsFrame(frame), position.space);
  const anchor = GRAPHICS_ANCHOR_POINTS[position.anchor];
  return {
    ...position,
    x: anchorFraction(space.x, space.width, box.x, anchor.x, box.width, position.x),
    y: anchorFraction(space.y, space.height, box.y, anchor.y, box.height, position.y),
  };
}

function lastCharacter(text: string): string {
  return Array.from(text).at(-1) ?? "";
}

function breaksBetween(left: string, right: string): boolean {
  return isUnspacedText(lastCharacter(left)) && isUnspacedText(Array.from(right)[0] ?? "");
}

function chunkPieces(chunk: string): string[] {
  if (!isUnspacedText(chunk)) return [chunk];
  return splitUnspacedText(chunk).reduce<string[]>((pieces, piece) => {
    const previous = pieces.at(-1);
    if (previous === undefined || breaksBetween(previous, piece)) return [...pieces, piece];
    return [...pieces.slice(0, -1), previous + piece];
  }, []);
}

function wrapUnits(paragraph: string): WrapUnit[] {
  return [...paragraph.matchAll(SPACE_RUN)].flatMap((match) => (
    chunkPieces(match[2]).map((text, index) => ({ text, space: index === 0 ? match[1] : "" }))
  ));
}

function wrapParagraph(units: readonly WrapUnit[], firstLimit: number, limit: number, width: (text: string) => number): FittedLine[] {
  const lines: FittedLine[] = [];
  let current: FittedLine | null = null;
  for (const unit of units) {
    if (current) {
      const joined: string = current.text + unit.space + unit.text;
      const joinedWidth = width(joined);
      if (joinedWidth <= (lines.length === 0 ? firstLimit : limit)) {
        current = { text: joined, width: joinedWidth };
        continue;
      }
      lines.push(current);
    }
    current = { text: unit.text, width: width(unit.text) };
  }
  return current ? [...lines, current] : [{ text: "", width: 0 }];
}

function shrinkingSizes(base: number): number[] {
  const minimum = base * MIN_FONT_SCALE;
  const sizes: number[] = [];
  for (let size = base; size > minimum + SIZE_EPSILON; size *= SHRINK_STEP) sizes.push(size);
  return [...sizes, minimum];
}

function iconSpace(item: GraphicsTextItem, size: number): number {
  return item.icon ? size * (ICON_SCALE + ICON_GAP_SCALE) : 0;
}

function fitAt(item: GraphicsTextItem, paragraphs: readonly WrapUnit[][], size: number, contentLimit: number, measure: GraphicsMeasure): FittedItem {
  const font: GraphicsFontSpec = { ...graphicsPresetFont(item.font), size };
  const width = (text: string): number => (text ? measure(text, font) : 0);
  const limit = contentLimit * FIT_SLACK;
  const firstLimit = limit - iconSpace(item, size);
  const lines = paragraphs.reduce<FittedLine[]>(
    (done, units) => [...done, ...wrapParagraph(units, done.length === 0 ? firstLimit : limit, limit, width)],
    [],
  );
  const fits = lines.length <= item.maxLines && lines.every((line, index) => line.width <= (index === 0 ? firstLimit : limit));
  return { item, font, lines, overflow: !fits };
}

function fitItem(item: GraphicsTextItem, text: string, contentLimit: number, context: LayoutContext): FittedItem {
  const paragraphs = text.split("\n").map(wrapUnits);
  const sizes = shrinkingSizes(item.size * context.short);
  for (const size of sizes.slice(0, -1)) {
    const fitted = fitAt(item, paragraphs, size, contentLimit, context.measure);
    if (!fitted.overflow) return fitted;
  }
  return fitAt(item, paragraphs, sizes[sizes.length - 1], contentLimit, context.measure);
}

function itemAccent(item: GraphicsTextItem, size: number): ItemAccent | null {
  if (item.accent === "none") return null;
  return { gap: size * ACCENT_GAP_SCALE, height: size * ACCENT_HEIGHT_SCALE[item.accent] };
}

function planItem(fitted: FittedItem, text: string): PlannedItem {
  const size = fitted.font.size;
  const metrics = graphicsLineMetrics(fitted.item.font, text);
  const lineHeight = size * (metrics.ascent + metrics.descent);
  const lead = iconSpace(fitted.item, size);
  const accent = itemAccent(fitted.item, size);
  return {
    ...fitted,
    ascent: size * metrics.ascent,
    lineHeight,
    icon: fitted.item.icon ? size * ICON_SCALE : 0,
    iconSpace: lead,
    accent,
    width: Math.max(...fitted.lines.map((line, index) => line.width + (index === 0 ? lead : 0))),
    height: fitted.lines.length * lineHeight + (accent ? accent.gap + accent.height : 0),
  };
}

function alignOffset(align: GraphicsTextLayer["align"], available: number, width: number): number {
  return (available - width) * ALIGN_FRACTIONS[align];
}

function itemLayout(item: PlannedItem, content: GraphicsRect, top: number, align: GraphicsTextLayer["align"]): GraphicsTextItemLayout {
  const starts = item.lines.map((line, index) => {
    const lead = index === 0 ? item.iconSpace : 0;
    return content.x + alignOffset(align, content.width, lead + line.width) + lead;
  });
  const lines = item.lines.map((line, index) => {
    const y = top + index * item.lineHeight;
    return { ...pixelRect({ x: starts[index], y, width: line.width, height: item.lineHeight }), text: line.text, baseline: px(y + item.ascent) };
  });
  const last = item.lines.length - 1;
  return {
    itemId: item.item.id,
    font: item.font,
    box: pixelRect({ x: content.x + alignOffset(align, content.width, item.width), y: top, width: item.width, height: item.height }),
    lines,
    icon: item.icon > 0
      ? pixelRect({ x: starts[0] - item.iconSpace, y: top + (item.lineHeight - item.icon) / 2, width: item.icon, height: item.icon })
      : null,
    accent: item.accent
      ? pixelRect({ x: starts[last], y: top + item.lines.length * item.lineHeight + item.accent.gap, width: item.lines[last].width, height: item.accent.height })
      : null,
    overflow: item.overflow,
  };
}

function itemTops(items: readonly PlannedItem[], top: number, gap: number): number[] {
  return items.reduce<{ tops: number[]; next: number }>(
    (state, item) => ({ tops: [...state.tops, state.next], next: state.next + item.height + gap }),
    { tops: [], next: top },
  ).tops;
}

function displayText(item: GraphicsTextItem): string {
  return captionCase(item.text.trim(), item.case === "upper", null);
}

function textLayout(layer: GraphicsTextLayer, context: LayoutContext): GraphicsTextLayout {
  const space = spaceRect(context.frame, layer.position.space);
  const padX = layer.plate ? layer.plate.paddingX * context.short : 0;
  const padY = layer.plate ? layer.plate.paddingY * context.short : 0;
  const contentLimit = Math.max(1, layer.width * space.width - 2 * padX);
  const planned = layer.items
    .map((item) => ({ item, text: displayText(item) }))
    .filter((entry) => entry.text.length > 0)
    .map((entry) => planItem(fitItem(entry.item, entry.text, contentLimit, context), entry.text));
  if (planned.length === 0) {
    const box = pixelRect(placeBox(space, layer.position, { width: 0, height: 0 }));
    return { kind: "text", layerId: layer.id, box, plate: null, items: [], overflow: false };
  }
  const gap = layer.gap * context.short;
  const contentWidth = Math.max(...planned.map((item) => item.width));
  const contentHeight = planned.reduce((sum, item) => sum + item.height, 0) + gap * (planned.length - 1);
  const box = placeBox(space, layer.position, { width: contentWidth + 2 * padX, height: contentHeight + 2 * padY });
  const content = { x: box.x + padX, y: box.y + padY, width: contentWidth, height: contentHeight };
  const tops = itemTops(planned, content.y, gap);
  const items = planned.map((item, index) => itemLayout(item, content, tops[index], layer.align));
  return {
    kind: "text",
    layerId: layer.id,
    box: pixelRect(box),
    plate: layer.plate ? roundedRect(box, (layer.plate.radius * box.height) / 2) : null,
    items,
    overflow: items.some((item) => item.overflow)
      || box.width > space.width + SIZE_EPSILON
      || box.height > space.height + SIZE_EPSILON,
  };
}

function imageLayout(layer: GraphicsImageLayer, context: LayoutContext): GraphicsImageLayout {
  const image = context.images[layer.artifactId];
  const ratio = image && image.width > 0 && image.height > 0 ? image.height / image.width : null;
  const width = layer.size * context.short;
  const size = { width, height: width * (ratio ?? 1) };
  const box = placeBox(spaceRect(context.frame, layer.position.space), layer.position, size);
  return { kind: "image", layerId: layer.id, box: pixelRect(box), missing: ratio === null };
}

function qrSide(size: number, short: number): number {
  return Math.max(2, 2 * Math.round((size * short) / 2));
}

function qrLayout(layer: GraphicsQrLayer, context: LayoutContext): GraphicsQrLayout {
  const side = qrSide(layer.size, context.short);
  const box = pixelRect(placeBox(spaceRect(context.frame, layer.position.space), layer.position, { width: side, height: side }));
  const tiled = layer.style === "tile";
  const pad = tiled ? Math.round(side * QR_TILE_PADDING) : 0;
  return {
    kind: "qr",
    layerId: layer.id,
    box,
    tile: tiled ? roundedRect(box, side * QR_TILE_RADIUS) : null,
    modules: { x: box.x + pad, y: box.y + pad, width: side - 2 * pad, height: side - 2 * pad },
  };
}

function scrimLayout(layer: GraphicsScrimLayer, frame: GraphicsFrame): GraphicsScrimLayout {
  const height = layer.height * frame.height;
  const y = layer.edge === "top" ? 0 : frame.height - height;
  return { kind: "scrim", layerId: layer.id, box: pixelRect({ x: 0, y, width: frame.width, height }) };
}

function layerLayout(layer: GraphicsLayer, context: LayoutContext): GraphicsLayerLayout {
  switch (layer.kind) {
    case "text": return textLayout(layer, context);
    case "image": return imageLayout(layer, context);
    case "qr": return qrLayout(layer, context);
    case "scrim": return scrimLayout(layer, context.frame);
  }
}

export function layoutGraphics(input: GraphicsLayoutInput): GraphicsLayerLayout[] {
  const frame = graphicsFrame(input.frame);
  const context: LayoutContext = {
    frame,
    short: Math.min(frame.width, frame.height),
    measure: input.measure,
    images: input.images ?? {},
  };
  return input.document.layers.filter((layer) => layer.visible).map((layer) => layerLayout(layer, context));
}
