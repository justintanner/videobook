import { describe, expect, it } from "vitest";
import { LIGHTNING_WATERMARK_PROFILE, X_WATERMARK_PROFILE } from "../lightning-defaults.js";
import type { GraphicsDocument, GraphicsFrame, GraphicsLayer, GraphicsTextLayer } from "./model.js";
import { parseGraphicsDocument } from "./model.js";
import { DEFAULT_GRAPHICS_STARTER_ID, GRAPHICS_STARTERS, graphicsSlotBlock, platformWatermarkDocument } from "./starters.js";

const FRAMES: GraphicsFrame[] = [
  { width: 1080, height: 1920 },
  { width: 1080, height: 1080 },
  { width: 1920, height: 1080 },
];

function starter(id: string): (frame: GraphicsFrame) => GraphicsDocument {
  const found = GRAPHICS_STARTERS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing starter ${id}`);
  return found.build;
}

function textLayers(document: GraphicsDocument): GraphicsTextLayer[] {
  return document.layers.filter((layer): layer is GraphicsTextLayer => layer.kind === "text");
}

function kinds(document: GraphicsDocument): GraphicsLayer["kind"][] {
  return document.layers.map((layer) => layer.kind);
}

import { fillGraphicsSlots } from "./slots.js";
import { layoutGraphics } from "./layout.js";

describe("graphics starters", () => {

  it("stacks the default handle above three Thai title lines within the portrait safe space", () => {
    const frame = FRAMES[0];
    const document = fillGraphicsSlots(platformWatermarkDocument(LIGHTNING_WATERMARK_PROFILE, frame, {}), {
      handle: "jtbkk", headline: "ฝนตกหนัก\nรถเมล์ไม่มา\nรอต่อไป", secondary: "Still waiting for the bus",
    }, { overwrite: true });
    expect(kinds(document)).toEqual(["scrim", "text"]);
    const [title] = textLayers(document);
    expect(title).toMatchObject({ name: "Title", plate: null, opacity: 1, timing: { start: null, end: null, fade: 0 } });
    expect(title.items.map(item => item.slot)).toEqual(["handle", "headline", "secondary"]);
    expect(title.items[0]).toMatchObject({ shadow: true, icon: "tiktok", size: 0.036 });
    const layout = layoutGraphics({ document, frame, measure: (text, font) => Array.from(text).length * font.size * 0.5 });
    const block = layout.find(layer => layer.kind === "text");
    if (!block || block.kind !== "text") throw new Error("missing title");
    expect(block.overflow).toBe(false);
    expect(block.items.every(item => !item.overflow)).toBe(true);
    expect(block.items[0].box.y + block.items[0].box.height).toBeLessThan(block.items[1].box.y);
    expect(block.items[1].box.y + block.items[1].box.height).toBeLessThan(block.items[2].box.y);
  });

  it("keeps explicit center and X profiles as separate handle pills", () => {
    const centered = platformWatermarkDocument({ ...LIGHTNING_WATERMARK_PROFILE, handlePlacement: "center" }, FRAMES[0], {});
    expect(textLayers(centered).map(layer => layer.name)).toEqual(["Title", "Handle"]);
    expect(textLayers(centered)[1]).toMatchObject({ plate: { border: true }, position: { anchor: "center", y: 0.1 }, opacity: 0.28 });
    const x = platformWatermarkDocument(X_WATERMARK_PROFILE, FRAMES[0], {});
    expect(kinds(x)).toEqual(["text"]);
    expect(textLayers(x)[0]).toMatchObject({ name: "Handle", plate: { border: true }, position: { y: 0.33 }, opacity: 0.5 });
  });

  it("lists five starters with tiktok-title first as the default", () => {
    expect(GRAPHICS_STARTERS.map((candidate) => candidate.id)).toEqual(["tiktok-title", "lower-third", "headline", "credit", "watermark"]);
    expect(DEFAULT_GRAPHICS_STARTER_ID).toBe("tiktok-title");
    expect(GRAPHICS_STARTERS[0].id).toBe(DEFAULT_GRAPHICS_STARTER_ID);
    expect(GRAPHICS_STARTERS.every((candidate) => candidate.name.length > 0)).toBe(true);
  });

  it.each(GRAPHICS_STARTERS.flatMap((candidate) => FRAMES.map((frame) => [candidate.id, frame] as const)))(
    "%s parses at %j and survives a JSON round trip",
    (id, frame) => {
      const document = starter(id)(frame);
      expect(parseGraphicsDocument(document)).toEqual({ ok: true, document });
      expect(parseGraphicsDocument(JSON.parse(JSON.stringify(document)))).toEqual({ ok: true, document });
    },
  );

  it("builds tiktok-title as a bottom shade under one title block: the profile's handle over an empty Thai title and English line, with no QR", () => {
    const document = starter("tiktok-title")({ width: 1080, height: 1920 });
    expect(kinds(document)).toEqual(["scrim", "text"]);
    expect(document.layers[0]).toMatchObject({ kind: "scrim", edge: "bottom" });
    const [title] = textLayers(document);
    expect(title).toMatchObject({ name: "Title", opacity: 1, plate: null, timing: { start: null, end: null, tail: null } });
    expect(title.position).toEqual({ anchor: "bottom-left", x: 0, y: 1, space: "safe" });
    expect(title.items).toMatchObject([
      { slot: "handle", text: LIGHTNING_WATERMARK_PROFILE.handle, icon: "tiktok", font: "heavy", size: 0.036, maxLines: 1, accent: "none" },
      { slot: "headline", text: "", font: "heavy", size: 0.09, maxLines: 3, accent: "brush" },
      { slot: "secondary", text: "", font: "heavy", size: 0.045 },
    ]);
  });

  it("writes the handle the profile carries, without its @, and drops the platform icon when the profile does", () => {
    const build = GRAPHICS_STARTERS[0].build;
    const [plain] = textLayers(build({ width: 1080, height: 1920 }, { ...LIGHTNING_WATERMARK_PROFILE, handle: "@kondee", includePlatformIcon: false }));
    expect(plain.items[0]).toMatchObject({ slot: "handle", text: "kondee", icon: null });
    const [onX] = textLayers(build({ width: 1080, height: 1920 }, { ...LIGHTNING_WATERMARK_PROFILE, platform: "x", handle: "someone" }));
    expect(onX.items[0]).toMatchObject({ slot: "handle", text: "someone", icon: "x" });
  });

  it("builds lower-third as a bottom scrim and one bottom-left block of headline, second line and credit", () => {
    const document = starter("lower-third")({ width: 1080, height: 1920 });
    expect(kinds(document)).toEqual(["scrim", "text"]);
    expect(document.layers[0]).toMatchObject({ edge: "bottom" });
    const [block] = textLayers(document);
    expect(block).toMatchObject({ position: { anchor: "bottom-left", x: 0, y: 1, space: "safe" }, width: 0.86, align: "left" });
    expect(block.items).toMatchObject([
      { slot: "headline", size: 0.068, maxLines: 4, accent: "brush", icon: null },
      { slot: "secondary", size: 0.044, accent: "none" },
      { slot: "credit", size: 0.03, icon: "camera" },
    ]);
    expect(block.items.every((item) => item.font === "heavy" && item.color === "#FFFFFF" && item.text === "")).toBe(true);
  });

  it("gives the headline, credit and watermark starters their slots", () => {
    const frame = { width: 1920, height: 1080 };
    expect(textLayers(starter("headline")(frame))[0].items.map((item) => item.slot)).toEqual(["headline"]);
    const credit = textLayers(starter("credit")(frame))[0];
    expect(credit.items).toMatchObject([{ slot: "credit", icon: "camera" }]);
    expect(credit.plate).not.toBeNull();
    const watermark = starter("watermark")(frame);
    expect(kinds(watermark)).toEqual(["qr", "text"]);
    expect(watermark.layers[0]).toMatchObject({ slot: "profile", url: LIGHTNING_WATERMARK_PROFILE.profileUrl, style: "tile" });
  });

  it("builds a bottom-left title block from the slots it is given, styled like the lower third", () => {
    const lower = textLayers(starter("lower-third")({ width: 1080, height: 1920 }))[0];
    const block = graphicsSlotBlock({ headline: "Red light legends", credit: "TikTok/@pomkondeena" });
    expect(block).toMatchObject({ kind: "text", name: "Title", position: lower.position, width: lower.width, align: lower.align, gap: lower.gap, plate: null });
    expect(block?.items).toMatchObject([
      { slot: "headline", text: "Red light legends", size: 0.068, maxLines: 4, accent: "brush" },
      { slot: "credit", text: "TikTok/@pomkondeena", size: 0.03, icon: "camera" },
    ]);
    expect(graphicsSlotBlock({})).toBeNull();
  });
});
