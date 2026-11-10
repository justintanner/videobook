import { describe, expect, it } from "vitest";
import { LIGHTNING_WATERMARK_PROFILE } from "../lightning-defaults.js";
import type { GraphicsDocument, GraphicsFrame, GraphicsLayer, GraphicsTextLayer } from "./model.js";
import { parseGraphicsDocument } from "./model.js";
import { DEFAULT_GRAPHICS_STARTER_ID, GRAPHICS_STARTERS } from "./starters.js";

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

describe("graphics starters", () => {
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

  it("builds tiktok-title from the TikTok watermark profile with an empty Thai title and English line and no QR", () => {
    const document = starter("tiktok-title")({ width: 1080, height: 1920 });
    expect(kinds(document)).toEqual(["scrim", "text", "text"]);
    expect(document.layers[0]).toMatchObject({ kind: "scrim", edge: "bottom" });
    const [title, handle] = textLayers(document);
    expect(title.position).toEqual({ anchor: "bottom-left", x: 0, y: 1, space: "safe" });
    expect(title.items).toMatchObject([
      { slot: "headline", text: "", font: "heavy", size: 0.09, maxLines: 3, accent: "brush" },
      { slot: "secondary", text: "", font: "heavy", size: 0.045 },
    ]);
    expect(handle.items).toMatchObject([{ slot: "handle", text: LIGHTNING_WATERMARK_PROFILE.handle, icon: "tiktok" }]);
    expect(handle.plate).toMatchObject({ border: LIGHTNING_WATERMARK_PROFILE.includeHandleBorder, radius: LIGHTNING_WATERMARK_PROFILE.handleRounding / 100 });
    expect(handle.opacity).toBe(LIGHTNING_WATERMARK_PROFILE.handleOpacity);
    expect(handle.position).toEqual({ anchor: "center", x: 0.5, y: LIGHTNING_WATERMARK_PROFILE.handleVerticalPercent / 100, space: "frame" });
    expect(handle.timing).toEqual({ start: null, end: LIGHTNING_WATERMARK_PROFILE.handleEndSeconds, tail: null, fade: LIGHTNING_WATERMARK_PROFILE.fadeSeconds });
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
});
