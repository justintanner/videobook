import { describe, expect, it } from "vitest";
import type { LightningWatermarkProfile } from "../lightning-defaults.js";
import { LIGHTNING_WATERMARK_PROFILE, X_WATERMARK_PROFILE } from "../lightning-defaults.js";
import type { OsgPosition } from "../remotion/subtitles/types.js";
import type { GraphicsLayerLayout, GraphicsMeasure, GraphicsRect, GraphicsTextItemLayout, GraphicsTextLayout } from "./layout.js";
import { graphicsPlaceBox, graphicsPositionForBox, graphicsSpaceRect, layoutGraphics } from "./layout.js";
import type {
  GraphicsAnchor,
  GraphicsDocument,
  GraphicsFrame,
  GraphicsLayerInput,
  GraphicsSpace,
  GraphicsTextItemInput,
  GraphicsTextLayerInput,
} from "./model.js";
import { appendGraphicsLayers, GRAPHICS_ANCHOR_POINTS, graphicsDocumentFromLayers, parseGraphicsDocument } from "./model.js";
import type { GraphicsSlotValues } from "./slots.js";
import { fillGraphicsSlots } from "./slots.js";
import type { GraphicsStarterId } from "./starters.js";
import { GRAPHICS_STARTERS } from "./starters.js";
import { watermarkDocumentFromProfile, watermarkLayerInputs } from "./watermark-profile.js";

const PORTRAIT: GraphicsFrame = { width: 1080, height: 1920 };
const SQUARE: GraphicsFrame = { width: 1080, height: 1080 };
const LANDSCAPE: GraphicsFrame = { width: 1920, height: 1080 };
const HEADLINE = "How can you look this cool while waiting at a red light?";
const THAI_LINE = "ติดไฟแดงยังไงให้เท่ได้ขนาดนี้";
const THAI_TITLE = "ติดไฟแดงยังไงให้เท่ได้ขนาดนี้ ใครเห็นก็ต้องหันมามองทุกคน แม้แต่ตำรวจจราจรยังยิ้ม";
const CREDIT = "TikTok/@pomkondeena";
const THAI_INK_ABOVE = 1046 / 1000;
const THAI_INK_BELOW = 445 / 1000;
const ROUNDING = 1;
const RECT_KEYS = ["x", "y", "width", "height"] as const;
const WORD_BOUNDARIES = new Intl.Segmenter(undefined, { granularity: "word" });

function advance(char: string): number {
  if (/\p{M}/u.test(char)) return 0;
  if (/\p{Script=Thai}/u.test(char)) return 0.56;
  if (char === " ") return 0.27;
  if (/\p{Lu}/u.test(char)) return 0.7;
  if (/\p{Ll}/u.test(char)) return 0.58;
  return 0.6;
}

const measure: GraphicsMeasure = (text, font) => (
  Array.from(text).reduce((sum, char) => sum + advance(char), 0) * font.size * (font.family.startsWith("\"Anton\"") ? 0.75 : 1)
);

function starter(id: GraphicsStarterId, frame: GraphicsFrame, values: GraphicsSlotValues = {}): GraphicsDocument {
  const found = GRAPHICS_STARTERS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no starter ${id}`);
  const document = fillGraphicsSlots(found.build(frame), values, { overwrite: true });
  expect(parseGraphicsDocument(document)).toEqual({ ok: true, document });
  return document;
}

function textBlock(fields: Partial<GraphicsTextLayerInput>, items: GraphicsTextItemInput[]): GraphicsDocument {
  return graphicsDocumentFromLayers([{ kind: "text", ...fields, items }]);
}

function layout(document: GraphicsDocument, frame: GraphicsFrame = PORTRAIT): GraphicsLayerLayout[] {
  return layoutGraphics({ document, frame, measure });
}

function only<K extends GraphicsLayerLayout["kind"]>(layouts: GraphicsLayerLayout[], kind: K, layerId?: string): Extract<GraphicsLayerLayout, { kind: K }> {
  const found = layouts.filter((candidate): candidate is Extract<GraphicsLayerLayout, { kind: K }> => (
    candidate.kind === kind && (layerId === undefined || candidate.layerId === layerId)
  ));
  if (found.length !== 1) throw new Error(`expected one ${kind} layout, found ${found.length}`);
  return found[0];
}

function inside(inner: GraphicsRect, outer: GraphicsRect): boolean {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

function overlaps(a: GraphicsRect, b: GraphicsRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function itemRects(item: GraphicsTextItemLayout): GraphicsRect[] {
  return [...item.lines, ...(item.icon ? [item.icon] : []), ...(item.accent ? [item.accent] : [])];
}

function labelledRects(layer: GraphicsLayerLayout): Array<{ label: string; rect: GraphicsRect }> {
  const box = [{ label: `${layer.layerId} box`, rect: layer.box }];
  if (layer.kind === "qr") {
    return [...box, { label: `${layer.layerId} modules`, rect: layer.modules }, ...(layer.tile ? [{ label: `${layer.layerId} tile`, rect: layer.tile }] : [])];
  }
  if (layer.kind !== "text") return box;
  const plate = layer.plate ? [{ label: `${layer.layerId} plate`, rect: layer.plate }] : [];
  const items = layer.items.flatMap((item) => [item.box, ...itemRects(item)].map((rect, index) => ({ label: `${item.itemId} ${index}`, rect })));
  return [...box, ...plate, ...items];
}

function burnedQrRect(profile: LightningWatermarkProfile, frame: GraphicsFrame, corner: OsgPosition): GraphicsRect {
  const side = Math.max(2, 2 * Math.round((Math.min(frame.width, frame.height) * 0.16 * profile.scale) / 2));
  const padding = Math.round(frame.width * 0.02);
  const [vertical, horizontal] = corner.split("-");
  const x = horizontal === "left" ? padding : horizontal === "right" ? frame.width - side - padding : (frame.width - side) / 2;
  const y = vertical === "top" ? padding : vertical === "bottom" ? frame.height - side - padding : (frame.height - side) / 2;
  return { x, y, width: side, height: side };
}

describe("graphicsSpaceRect", () => {
  it("measures the frame, the 2% inset and the platform-safe area in whole pixels", () => {
    expect(graphicsSpaceRect(PORTRAIT, "frame")).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
    expect(graphicsSpaceRect(PORTRAIT, "inset")).toEqual({ x: 22, y: 22, width: 1036, height: 1876 });
    expect(graphicsSpaceRect(PORTRAIT, "safe")).toEqual({ x: 54, y: 163, width: 891, height: 1335 });
    expect(graphicsSpaceRect(LANDSCAPE, "inset")).toEqual({ x: 38, y: 38, width: 1844, height: 1004 });
    expect(graphicsSpaceRect(LANDSCAPE, "safe")).toEqual({ x: 96, y: 65, width: 1728, height: 907 });
    expect(graphicsSpaceRect(SQUARE, "safe")).toEqual({ x: 54, y: 65, width: 972, height: 907 });
  });

  it("uses the safe zone of the caption aspect nearest the frame", () => {
    expect(graphicsSpaceRect({ width: 720, height: 1280 }, "safe")).toEqual({ x: 36, y: 109, width: 594, height: 889 });
    expect(graphicsSpaceRect({ width: 1080, height: 1350 }, "safe")).toEqual({ x: 54, y: 81, width: 940, height: 1107 });
    expect(graphicsSpaceRect({ width: 1440, height: 1080 }, "safe")).toEqual({ x: 72, y: 65, width: 1296, height: 907 });
    expect(() => graphicsSpaceRect({ width: 0, height: 1080 }, "safe")).toThrow(/Frame sides/u);
  });
});

describe("graphicsPositionForBox", () => {
  const SIZE = { width: 300, height: 120 };
  const ANCHORS = Object.keys(GRAPHICS_ANCHOR_POINTS) as GraphicsAnchor[];
  const SPACES: GraphicsSpace[] = ["safe", "inset", "frame"];

  it.each([PORTRAIT, SQUARE, LANDSCAPE])("inverts graphicsPlaceBox for every anchor and space at %j", (frame) => {
    for (const anchor of ANCHORS) {
      for (const space of SPACES) {
        const target = { x: 0.37 * frame.width, y: 0.41 * frame.height, ...SIZE };
        const position = graphicsPositionForBox(frame, { anchor, x: 0.5, y: 0.5, space }, target);
        expect(position).toMatchObject({ anchor, space });
        const placed = graphicsPlaceBox(frame, position, SIZE);
        expect(Math.abs(placed.x - target.x)).toBeLessThan(0.05);
        expect(Math.abs(placed.y - target.y)).toBeLessThan(0.05);
      }
    }
  });

  it("keeps a box inside its space and the anchor point where the box puts it", () => {
    const safe = graphicsSpaceRect(PORTRAIT, "safe");
    const corner = graphicsPositionForBox(PORTRAIT, { anchor: "bottom-left", x: 0.5, y: 0.5, space: "safe" }, { x: -500, y: 5000, ...SIZE });
    expect(corner).toEqual({ anchor: "bottom-left", x: 0, y: 1, space: "safe" });
    const centre = graphicsPositionForBox(PORTRAIT, { anchor: "center", x: 0, y: 0, space: "frame" }, { x: 390, y: 900, ...SIZE });
    expect(centre).toEqual({ anchor: "center", x: 0.5, y: 0.5, space: "frame" });
    const placed = graphicsPlaceBox(PORTRAIT, corner, SIZE);
    expect(placed.x).toBeCloseTo(safe.x, 0);
    expect(placed.y + placed.height).toBeCloseTo(safe.y + safe.height, 0);
  });

  it("leaves an axis alone when the box is larger than its space", () => {
    const position = graphicsPositionForBox(SQUARE, { anchor: "top", x: 0.3, y: 0.2, space: "safe" }, { x: 10, y: 400, width: 2000, height: 100 });
    expect(position.x).toBe(0.3);
    expect(position.y).not.toBe(0.2);
  });
});

describe("layoutGraphics", () => {
  it.each([PORTRAIT, SQUARE, LANDSCAPE])("keeps the filled lower third inside the safe area at %j, items apart, the shade on the bottom edge", (frame) => {
    const layouts = layout(starter("lower-third", frame, { headline: HEADLINE, secondary: THAI_LINE, credit: CREDIT }), frame);
    const safe = graphicsSpaceRect(frame, "safe");
    const block = only(layouts, "text");
    expect(block.overflow).toBe(false);
    expect(inside(block.box, safe)).toBe(true);
    expect(block.box.x).toBe(safe.x);
    expect(block.box.y + block.box.height).toBe(safe.y + safe.height);
    expect(block.items).toHaveLength(3);
    for (const item of block.items) {
      expect(inside(item.box, block.box)).toBe(true);
      for (const rect of itemRects(item)) expect(inside(rect, item.box)).toBe(true);
    }
    block.items.forEach((item, index) => block.items.slice(index + 1).forEach((other) => expect(overlaps(item.box, other.box)).toBe(false)));
    const shade = only(layouts, "scrim");
    expect(shade.box).toEqual({ x: 0, y: Math.round(frame.height * 0.55), width: frame.width, height: frame.height - Math.round(frame.height * 0.55) });
    expect(shade.box.y + shade.box.height).toBe(frame.height);
  });

  it("draws the credit icon before the first line and the headline stroke under its last line", () => {
    const block = only(layout(starter("lower-third", PORTRAIT, { headline: HEADLINE, secondary: THAI_LINE, credit: CREDIT })), "text");
    const [headline, , credit] = block.items;
    const last = headline.lines[headline.lines.length - 1];
    expect(headline.accent).toMatchObject({ x: last.x, width: last.width });
    expect(headline.accent?.y).toBeGreaterThanOrEqual(last.y + last.height);
    expect(credit.lines).toHaveLength(1);
    const icon = credit.icon;
    if (!icon) throw new Error("expected a camera icon box");
    expect(icon.width).toBe(icon.height);
    expect(icon.x).toBe(credit.box.x);
    expect(icon.x + icon.width).toBeLessThan(credit.lines[0].x);
    expect(Math.abs(icon.y + icon.height / 2 - (credit.lines[0].y + credit.lines[0].height / 2))).toBeLessThanOrEqual(1);
    expect(block.items[1].icon).toBeNull();
    expect(block.items[1].accent).toBeNull();
  });

  it("wraps Thai only at word boundaries and never splits a grapheme", () => {
    const text = "ทำไมคนไทยถึงชอบกินข้าวเหนียวมะม่วงในหน้าร้อนมากที่สุดในโลก";
    const block = only(layout(textBlock({ width: 0.4 }, [{ text, size: 0.05, maxLines: 6 }])), "text");
    const [item] = block.items;
    expect(item.overflow).toBe(false);
    expect(item.lines.length).toBeGreaterThanOrEqual(3);
    expect(item.lines.map((line) => line.text).join("")).toBe(text);
    const boundaries = new Set([...WORD_BOUNDARIES.segment(text)].map((segment) => segment.index));
    item.lines.slice(0, -1).reduce((offset, line) => {
      const next = offset + line.text.length;
      expect(boundaries.has(next)).toBe(true);
      return next;
    }, 0);
    for (const line of item.lines) expect(line.text).not.toMatch(/^\p{M}/u);
    expect(Math.max(...item.lines.map((line) => line.width))).toBeLessThanOrEqual(Math.ceil(0.4 * 891));
  });

  it("breaks mixed text at spaces and between Thai words, but not before punctuation or inside Latin", () => {
    const text = "Red light! ติดไฟแดงยังไงให้เท่ได้ขนาดนี้? TikTok/@pomkondeena";
    const [item] = only(layout(textBlock({ width: 0.25 }, [{ text, size: 0.04, maxLines: 6 }])), "text").items;
    const lines = item.lines.map((line) => line.text);
    expect(lines.join(" ").replace(/ /gu, "")).toBe(text.replace(/ /gu, ""));
    expect(lines.some((line) => line.startsWith("?") || line.startsWith("!"))).toBe(false);
    expect(lines).toContain("TikTok/@pomkondeena");
    expect(lines.filter((line) => /\p{Script=Thai}/u.test(line)).length).toBeGreaterThanOrEqual(2);
  });

  it("shrinks a token that is too wide in steps of 0.92 until it fits", () => {
    const [item] = only(layout(textBlock({ width: 0.63 }, [{ text: "Supercalifragilistic", size: 0.05, maxLines: 1 }])), "text").items;
    expect(item.overflow).toBe(false);
    expect(item.font.size).toBeCloseTo(0.05 * 1080 * 0.92 ** 2, 10);
    expect(item.lines.map((line) => line.text)).toEqual(["Supercalifragilistic"]);
  });

  it.each([
    ["a Latin token", "pomkondeena.tiktok.example/very-long-handle"],
    ["a single Thai word", "ประชาธิปไตย"],
  ])("shrinks %s to 0.6 of its size, keeps it whole and reports overflow", (_name, token) => {
    const block = only(layout(textBlock({ width: 0.1 }, [{ text: token, size: 0.08, maxLines: 2 }])), "text");
    const [item] = block.items;
    expect(item.font.size).toBeCloseTo(0.08 * 1080 * 0.6, 10);
    expect(item.lines.map((line) => line.text).join("")).toBe(token);
    expect(item.lines.length).toBeLessThanOrEqual(2);
    expect(item.overflow).toBe(true);
    expect(block.overflow).toBe(true);
  });

  it("honours typed newlines, counts them against maxLines and closes the gap of an empty item", () => {
    const block = only(layout(textBlock({ gap: 0.02, align: "left" }, [
      { text: "Line one\nLine two", maxLines: 2 },
      { text: "  ", slot: "secondary" },
      { text: "Credit" },
    ])), "text");
    expect(block.items.map((item) => item.itemId)).toEqual(["t2", "t4"]);
    expect(block.items[0].lines.map((line) => line.text)).toEqual(["Line one", "Line two"]);
    const gap = block.items[1].box.y - (block.items[0].box.y + block.items[0].box.height);
    expect(Math.abs(gap - 0.02 * 1080)).toBeLessThanOrEqual(1);
    const crowded = only(layout(textBlock({}, [{ text: "one\ntwo\nthree", maxLines: 2 }])), "text");
    expect(crowded.items[0].lines).toHaveLength(3);
    expect(crowded.items[0].overflow).toBe(true);
  });

  it("aligns every line inside the block and keeps lines and plate in whole pixels", () => {
    const items: GraphicsTextItemInput[] = [{ text: "A much longer opening line\nshort", maxLines: 2 }];
    for (const align of ["left", "center", "right"] as const) {
      const block = only(layout(textBlock({ align, width: 0.9 }, items)), "text");
      const [item] = block.items;
      for (const line of item.lines) {
        if (align === "left") expect(line.x).toBe(block.box.x);
        if (align === "right") expect(Math.abs(line.x + line.width - (block.box.x + block.box.width))).toBeLessThanOrEqual(1);
        if (align === "center") expect(Math.abs(line.x + line.width / 2 - (block.box.x + block.box.width / 2))).toBeLessThanOrEqual(1);
      }
      for (const rect of [block.box, item.box, ...item.lines]) for (const key of RECT_KEYS) expect(Number.isInteger(rect[key])).toBe(true);
    }
  });

  it("pads the plate around the text and rounds its corners from half its height", () => {
    const block = only(layout(starter("credit", PORTRAIT, { credit: CREDIT })), "text");
    const [item] = block.items;
    const plate = block.plate;
    if (!plate) throw new Error("expected a plate");
    expect(plate).toMatchObject(block.box);
    expect(item.box.x - plate.x).toBe(Math.round(0.014 * 1080));
    expect(Math.abs(item.box.y - plate.y - 0.008 * 1080)).toBeLessThanOrEqual(1);
    expect(Math.abs(plate.radius - plate.height / 2)).toBeLessThanOrEqual(0.5);
  });

  it("fits the starters' handle pill and centres it on the profile's line", () => {
    const handle = only(layout(starter("tiktok-title", PORTRAIT)), "text", "l5");
    expect(handle.overflow).toBe(false);
    expect(handle.items.map((item) => item.lines.map((line) => line.text))).toEqual([["jtbkk"]]);
    expect(Math.abs(handle.box.x + handle.box.width / 2 - 540)).toBeLessThanOrEqual(1);
    expect(Math.abs(handle.box.y + handle.box.height / 2 - 192)).toBeLessThanOrEqual(1);
    expect(handle.items[0].icon).not.toBeNull();
  });

  it.each([PORTRAIT, LANDSCAPE])("fits a three-line Thai title in the tiktok-title safe area at %j with room for marks above and below each line", (frame) => {
    const layouts = layout(starter("tiktok-title", frame, { headline: THAI_TITLE, secondary: HEADLINE }), frame);
    const title = only(layouts, "text", "l2");
    const short = Math.min(frame.width, frame.height);
    expect(title.overflow).toBe(false);
    expect(inside(title.box, graphicsSpaceRect(frame, "safe"))).toBe(true);
    const [headline, secondary] = title.items;
    expect(headline.lines).toHaveLength(3);
    expect(headline.font.size).toBeLessThanOrEqual(0.09 * short);
    expect(headline.font.size).toBeGreaterThanOrEqual(0.09 * short * 0.6);
    for (const line of headline.lines) {
      expect(line.baseline - line.y).toBeGreaterThanOrEqual(headline.font.size * THAI_INK_ABOVE - ROUNDING);
      expect(line.y + line.height - line.baseline).toBeGreaterThanOrEqual(headline.font.size * THAI_INK_BELOW - ROUNDING);
    }
    headline.lines.slice(1).forEach((line, index) => expect(line.y).toBe(headline.lines[index].y + headline.lines[index].height));
    expect(secondary.box.y).toBeGreaterThan(headline.box.y + headline.box.height);
  });

  it("scales a layout at 1080x1920 to 540x960 by 0.5 within 1 px", () => {
    const base = starter("lower-third", PORTRAIT, { headline: HEADLINE, secondary: THAI_LINE, credit: CREDIT });
    const extras: GraphicsLayerInput[] = [
      { kind: "scrim", edge: "top", height: 0.18 },
      { kind: "image", artifactId: "logo", position: { anchor: "top-left", x: 0, y: 0, space: "safe" }, size: 0.17 },
      ...watermarkLayerInputs(LIGHTNING_WATERMARK_PROFILE, PORTRAIT, { includeQr: true }),
    ];
    const document = appendGraphicsLayers(base, extras);
    const images = { logo: { width: 640, height: 300 } };
    const full = layoutGraphics({ document, frame: PORTRAIT, measure, images });
    const half = layoutGraphics({ document, frame: { width: 540, height: 960 }, measure, images });
    expect(half.map((layer) => layer.kind)).toEqual(full.map((layer) => layer.kind));
    const fullRects = full.flatMap(labelledRects);
    const halfRects = half.flatMap(labelledRects);
    expect(halfRects.map((entry) => entry.label)).toEqual(fullRects.map((entry) => entry.label));
    expect(fullRects.length).toBeGreaterThan(20);
    halfRects.forEach((entry, index) => {
      for (const key of RECT_KEYS) expect(Math.abs(entry.rect[key] - fullRects[index].rect[key] / 2), `${entry.label} ${key}`).toBeLessThanOrEqual(1);
    });
    const texts = (layers: GraphicsLayerLayout[]) => layers.flatMap((layer) => (layer.kind === "text" ? layer.items : []));
    texts(half).forEach((item, index) => {
      const twin = texts(full)[index];
      expect(item.lines.map((line) => line.text)).toEqual(twin.lines.map((line) => line.text));
      expect(item.font.size).toBeCloseTo(twin.font.size / 2, 10);
    });
  });

  it.each([
    ["tiktok", LIGHTNING_WATERMARK_PROFILE, PORTRAIT],
    ["tiktok", LIGHTNING_WATERMARK_PROFILE, LANDSCAPE],
    ["x", X_WATERMARK_PROFILE, PORTRAIT],
    ["x", X_WATERMARK_PROFILE, LANDSCAPE],
  ] as const)("puts the %s watermark QR tile within 2 px of today's burn at %j", (_name, profile, frame) => {
    const qr = only(layout(watermarkDocumentFromProfile(profile, frame, { includeQr: true }), frame), "qr");
    const burned = burnedQrRect(profile, frame, "bottom-right");
    for (const key of RECT_KEYS) expect(Math.abs(qr.box[key] - burned[key])).toBeLessThanOrEqual(2);
    expect(qr.tile).toEqual({ ...qr.box, radius: Math.round((qr.box.width / 12) * 100) / 100 });
    const pad = Math.round(qr.box.width * 0.1);
    expect(qr.modules).toEqual({ x: qr.box.x + pad, y: qr.box.y + pad, width: qr.box.width - 2 * pad, height: qr.box.height - 2 * pad });
  });

  it("places the QR tile in every corner exactly where the burn does", () => {
    const corners: OsgPosition[] = ["top-left", "top-center", "top-right", "middle-left", "middle-center", "middle-right", "bottom-left", "bottom-center", "bottom-right"];
    for (const frame of [PORTRAIT, LANDSCAPE]) {
      for (const corner of corners) {
        const qr = only(layout(watermarkDocumentFromProfile(LIGHTNING_WATERMARK_PROFILE, frame, { includeQr: true, corner }), frame), "qr");
        expect(qr.box, `${corner} at ${frame.width}x${frame.height}`).toEqual(burnedQrRect(LIGHTNING_WATERMARK_PROFILE, frame, corner));
      }
    }
  });

  it("draws a plain QR code without a tile, its modules filling the box", () => {
    const qr = only(layout(graphicsDocumentFromLayers([{ kind: "qr", url: "https://example.com/a", style: "plain", size: 0.2 }])), "qr");
    expect(qr.tile).toBeNull();
    expect(qr.modules).toEqual(qr.box);
    expect(qr.box.width).toBe(216);
  });

  it("sizes an image from its width and natural aspect, and marks one it cannot find", () => {
    const document = graphicsDocumentFromLayers([
      { kind: "image", artifactId: "logo", position: { anchor: "top-left", x: 0, y: 0, space: "safe" }, size: 0.2 },
      { kind: "image", artifactId: "gone", position: { anchor: "top-right", x: 1, y: 0, space: "inset" }, size: 0.1 },
    ]);
    const [logo, gone] = layoutGraphics({ document, frame: PORTRAIT, measure, images: { logo: { width: 400, height: 100 } } });
    expect(logo).toEqual({ kind: "image", layerId: "l1", box: { x: 54, y: 163, width: 216, height: 54 }, missing: false });
    expect(gone).toEqual({ kind: "image", layerId: "l2", box: { x: 950, y: 22, width: 108, height: 108 }, missing: true });
  });

  it("lays out visible layers only, bottom to top", () => {
    const document = graphicsDocumentFromLayers([
      { kind: "scrim", edge: "top", height: 0.3 },
      { kind: "text", visible: false, items: [{ text: "Hidden" }] },
      { kind: "text", items: [{ text: "Shown" }] },
    ]);
    const layouts = layout(document);
    expect(layouts.map((layer) => layer.layerId)).toEqual(["l1", "l4"]);
    expect(only(layouts, "scrim").box).toEqual({ x: 0, y: 0, width: 1080, height: 576 });
  });

  it("gives a text layer with nothing typed an empty box at its anchor", () => {
    const block = only(layout(starter("headline", PORTRAIT)), "text");
    expect(block.items).toEqual([]);
    expect(block.plate).toBeNull();
    expect(block.overflow).toBe(false);
    expect(block.box).toEqual({ x: 500, y: 163, width: 0, height: 0 });
  });

  it("keeps every box inside its positioning space for every anchor and edge position", () => {
    const anchors = Object.keys(GRAPHICS_ANCHOR_POINTS) as GraphicsAnchor[];
    const spaces: GraphicsSpace[] = ["safe", "inset", "frame"];
    for (const frame of [PORTRAIT, SQUARE, LANDSCAPE]) {
      for (const space of spaces) {
        const layers: GraphicsLayerInput[] = anchors.flatMap((anchor) => [0, 0.5, 1].flatMap((at): GraphicsLayerInput[] => [
          { kind: "text", position: { anchor, x: at, y: 1 - at, space }, width: 0.5, plate: { paddingX: 0.02 }, items: [{ text: "On the edge", icon: "pin" }] },
          { kind: "qr", url: "https://example.com", position: { anchor, x: at, y: at, space }, size: 0.12 },
        ])).slice(0, 24);
        const bounds = graphicsSpaceRect(frame, space);
        for (const placed of layoutGraphics({ document: graphicsDocumentFromLayers(layers), frame, measure })) {
          expect(inside(placed.box, bounds), `${placed.layerId} in ${space} at ${frame.width}x${frame.height}`).toBe(true);
        }
      }
    }
  });

  it("centres a block taller than its space on that space and reports overflow", () => {
    const text = ["one", "two", "three", "four", "five", "six"].join("\n");
    const block: GraphicsTextLayout = only(layout(textBlock({ position: { anchor: "bottom-left", x: 0, y: 1, space: "safe" } }, [{ text, size: 0.3, maxLines: 6 }]), LANDSCAPE), "text");
    const safe = graphicsSpaceRect(LANDSCAPE, "safe");
    expect(block.overflow).toBe(true);
    expect(block.items[0].overflow).toBe(false);
    expect(block.box.height).toBeGreaterThan(safe.height);
    expect(Math.abs(block.box.y + block.box.height / 2 - (safe.y + safe.height / 2))).toBeLessThanOrEqual(1);
    expect(block.box.x).toBe(safe.x);
  });
});
