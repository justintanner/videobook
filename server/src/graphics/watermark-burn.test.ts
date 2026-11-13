import { describe, expect, it } from "vitest";
import type { LightningWatermarkProfile } from "../lightning-defaults.js";
import { LIGHTNING_WATERMARK_PROFILE, X_WATERMARK_PROFILE } from "../lightning-defaults.js";
import type { GraphicsDocument, GraphicsLayer, GraphicsLayerInput, GraphicsQrLayer, GraphicsTextLayer } from "./model.js";
import { graphicsDocumentFromLayers, parseGraphicsDocument } from "./model.js";
import { clearGraphicsSlots } from "./slots.js";
import { graphicsStillGroups } from "./stills.js";
import type { WatermarkBurnInput } from "./watermark-burn.js";
import { watermarkBurnDocument, watermarkTemplateDraws } from "./watermark-burn.js";
import { watermarkHandleHeight, watermarkLayerInputs, watermarkSlotValues } from "./watermark-profile.js";

const FRAME = { width: 1080, height: 1920 };
const DURATION = 12;
const CREDIT = "TikTok/@pomkondeena";

function input(profile: LightningWatermarkProfile, fields: Partial<WatermarkBurnInput> = {}): WatermarkBurnInput {
  return {
    profile,
    frame: FRAME,
    includeQr: false,
    includeHandle: true,
    corner: "bottom-right",
    qrWindow: { startSeconds: 9.7, endSeconds: null },
    handleWindow: { startSeconds: null, endSeconds: 3 },
    values: watermarkSlotValues(profile),
    template: null,
    patches: [],
    card: null,
    ...fields,
  };
}

function burned(fields: WatermarkBurnInput): GraphicsDocument {
  const document = watermarkBurnDocument(fields);
  expect(parseGraphicsDocument(document)).toEqual({ ok: true, document });
  return document;
}

function drawn(document: GraphicsDocument): GraphicsLayer[] {
  const ids = new Set(graphicsStillGroups(document, DURATION).flatMap((group) => group.layerIds));
  return document.layers.filter((layer) => ids.has(layer.id));
}

function kinds(layers: readonly GraphicsLayer[]): string[] {
  return layers.map((layer) => layer.kind);
}

function qrOf(document: GraphicsDocument): GraphicsQrLayer {
  const layer = document.layers.find((candidate): candidate is GraphicsQrLayer => candidate.kind === "qr");
  if (!layer) throw new Error("expected a QR layer");
  return layer;
}

function handleLayer(document: GraphicsDocument): GraphicsTextLayer {
  const layer = document.layers.find((candidate): candidate is GraphicsTextLayer => candidate.kind === "text" && candidate.items.some((item) => item.slot === "handle"));
  if (!layer) throw new Error("expected a handle layer");
  return layer;
}

function savedTemplate(layers: readonly GraphicsLayerInput[]): GraphicsDocument {
  return clearGraphicsSlots(graphicsDocumentFromLayers(layers));
}

function creditTemplate(): GraphicsDocument {
  const pill = watermarkLayerInputs({ ...LIGHTNING_WATERMARK_PROFILE, handleVerticalPercent: 20, handleOpacity: 0.6 }, FRAME, { includeQr: false });
  return savedTemplate([
    { kind: "scrim", edge: "bottom", height: 0.3, strength: 0.6 },
    {
      kind: "text",
      name: "Credit",
      position: { anchor: "bottom-left", x: 0, y: 1, space: "safe" },
      items: [{ text: "", slot: "credit", size: 0.03, icon: "camera" }],
    },
    ...pill,
  ]);
}

describe("watermark burn documents", () => {
  it("burns the TikTok handle alone by default: tiktok-title with no QR and no shade behind the empty title", () => {
    const document = burned(input(LIGHTNING_WATERMARK_PROFILE));
    expect(document.layers.some((layer) => layer.kind === "qr")).toBe(false);
    expect(document.layers.some((layer) => layer.kind === "scrim")).toBe(false);
    expect(document.layers.filter((layer) => layer.kind === "text").map((layer) => layer.name)).toEqual(["Title", "Handle"]);
    expect(kinds(drawn(document))).toEqual(["text"]);
    expect(handleLayer(document).items[0]).toMatchObject({ text: "jtbkk", slot: "handle", icon: "tiktok" });
    expect(handleLayer(document).timing).toEqual({ start: null, end: 3, tail: null, fade: LIGHTNING_WATERMARK_PROFILE.fadeSeconds, enter: "fade", exit: "fade" });
  });

  it("adds the QR code when asked, at the resolved corner and inside its window", () => {
    const document = burned(input(LIGHTNING_WATERMARK_PROFILE, { includeQr: true, corner: "top-left" }));
    expect(kinds(drawn(document))).toEqual(["qr", "text"]);
    expect(qrOf(document)).toMatchObject({
      url: "https://www.tiktok.com/@jtbkk",
      slot: "profile",
      position: { anchor: "top-left", x: 0, y: 0, space: "inset" },
      timing: { start: 9.7, end: null },
    });
  });

  it("burns the X handle without the TikTok title block", () => {
    const document = burned(input(X_WATERMARK_PROFILE));
    expect(kinds(document.layers)).toEqual(["text"]);
    expect(handleLayer(document).items[0]).toMatchObject({ text: "justinwtanner", icon: "x" });
  });

  it("burns a short's Thai title and English line in the TikTok title block, with its shade, beside the handle", () => {
    const values = { ...watermarkSlotValues(LIGHTNING_WATERMARK_PROFILE), headline: "รอรถเมล์กลางฝน", secondary: "Waiting for the bus in the rain" };
    const document = burned(input(LIGHTNING_WATERMARK_PROFILE, { values }));
    expect(kinds(drawn(document))).toEqual(["scrim", "text", "text"]);
    const title = document.layers.find((layer): layer is GraphicsTextLayer => layer.kind === "text" && layer.name === "Title");
    expect(title?.items.map((item) => [item.slot, item.text])).toEqual([["headline", "รอรถเมล์กลางฝน"], ["secondary", "Waiting for the bus in the rain"]]);
    expect(handleLayer(document).items[0]).toMatchObject({ text: "jtbkk", slot: "handle" });
    expect(kinds(drawn(burned(input(LIGHTNING_WATERMARK_PROFILE, { values: { ...values, secondary: "" } }))))).toEqual(["scrim", "text", "text"]);
  });

  it("reports whether a saved template can draw a title, ignoring hidden layers", () => {
    const titled = savedTemplate([{ kind: "text", name: "Title", position: { anchor: "bottom-left", x: 0, y: 1, space: "safe" }, items: [{ text: "", slot: "headline", size: 0.09 }, { text: "", slot: "secondary", size: 0.045 }] }]);
    expect(watermarkTemplateDraws(titled)).toMatchObject({ headline: true, secondary: true });
    expect(watermarkTemplateDraws({ ...titled, layers: titled.layers.map((layer) => ({ ...layer, visible: false })) })).toMatchObject({ headline: false, secondary: false });
    expect(watermarkTemplateDraws(creditTemplate())).toMatchObject({ headline: false, secondary: false });
  });

  it("fills a saved template's credit on a downloaded video, keeping its shade, and skips both on a generated one", () => {
    const template = creditTemplate();
    expect(watermarkTemplateDraws(template)).toEqual({ qr: false, handle: true, credit: true, headline: false, secondary: false });
    const downloaded = burned(input(LIGHTNING_WATERMARK_PROFILE, { template, values: { ...watermarkSlotValues(LIGHTNING_WATERMARK_PROFILE), credit: CREDIT } }));
    expect(kinds(drawn(downloaded))).toEqual(["scrim", "text", "text"]);
    expect(downloaded.layers.find((layer) => layer.name === "Credit")).toMatchObject({ items: [{ text: CREDIT, slot: "credit" }] });
    expect(handleLayer(downloaded).items[0].text).toBe("jtbkk");
    const generated = burned(input(LIGHTNING_WATERMARK_PROFILE, { template }));
    expect(generated.layers.some((layer) => layer.kind === "scrim")).toBe(false);
    expect(drawn(generated).map((layer) => layer.name)).toEqual(["Handle"]);
  });

  it("keeps the template's own placement, opacity and timing unless the caller set them", () => {
    const template = creditTemplate();
    const kept = handleLayer(burned(input(X_WATERMARK_PROFILE, { template, values: watermarkSlotValues(X_WATERMARK_PROFILE) })));
    expect(kept).toMatchObject({ opacity: 0.6, position: { y: 0.2 }, timing: handleLayer(template).timing });
    expect(kept.items[0]).toMatchObject({ text: "justinwtanner", icon: "tiktok" });
    const patched = handleLayer(burned(input(X_WATERMARK_PROFILE, {
      template,
      values: watermarkSlotValues(X_WATERMARK_PROFILE),
      patches: ["handleOpacity", "handleTiming", "handleStyle"],
      handleWindow: { startSeconds: 1, endSeconds: 4 },
    })));
    expect(patched).toMatchObject({ opacity: X_WATERMARK_PROFILE.handleOpacity, position: { y: 0.33 }, timing: { start: 1, end: 4 } });
    expect(patched.items[0]).toMatchObject({ text: "justinwtanner", icon: "x" });
  });

  it("restyles only a stand-alone handle pill, never a handle line inside another block", () => {
    const template = savedTemplate([{
      kind: "text",
      name: "Sign-off",
      position: { anchor: "bottom", x: 0.5, y: 1, space: "safe" },
      items: [{ text: "Follow for more", size: 0.04 }, { text: "", slot: "handle", size: 0.03, icon: null }],
    }]);
    const document = burned(input(LIGHTNING_WATERMARK_PROFILE, { template, patches: ["handleStyle", "handleOpacity"] }));
    const layer = handleLayer(document);
    expect(layer).toMatchObject({ name: "Sign-off", position: { anchor: "bottom", y: 1, space: "safe" }, opacity: LIGHTNING_WATERMARK_PROFILE.handleOpacity });
    expect(layer.items.map((item) => item.text)).toEqual(["Follow for more", "jtbkk"]);
    expect(layer.items[1]).toMatchObject({ size: 0.03, icon: null });
  });

  it("adds, removes and patches the profile QR layer of a template", () => {
    const qrTemplate = savedTemplate([
      ...watermarkLayerInputs(LIGHTNING_WATERMARK_PROFILE, FRAME, { includeQr: true, corner: "top-right", qrWindow: { startSeconds: 2, endSeconds: 5 } }),
      { kind: "qr", name: "Shop", url: "https://example.com/shop", slot: null, position: { anchor: "top-left", x: 0, y: 0, space: "inset" } },
    ]);
    expect(watermarkTemplateDraws(qrTemplate)).toMatchObject({ qr: true, handle: true });
    const kept = burned(input(LIGHTNING_WATERMARK_PROFILE, { template: qrTemplate, includeQr: true }));
    expect(qrOf(kept)).toMatchObject({ url: "https://www.tiktok.com/@jtbkk", position: { anchor: "top-right" }, timing: { start: 2, end: 5 } });
    const moved = burned(input(LIGHTNING_WATERMARK_PROFILE, {
      template: qrTemplate,
      includeQr: true,
      corner: "bottom-left",
      patches: ["position", "scale", "qrOpacity", "qrTiming"],
      profile: { ...LIGHTNING_WATERMARK_PROFILE, scale: 1.5, qrOpacity: 0.9 },
      values: { ...watermarkSlotValues(LIGHTNING_WATERMARK_PROFILE), profile: "https://example.com/me" },
    }));
    expect(qrOf(moved)).toMatchObject({
      url: "https://example.com/me",
      position: { anchor: "bottom-left", x: 0, y: 1, space: "inset" },
      opacity: 0.9,
      timing: { start: 9.7, end: null },
    });
    expect(qrOf(moved).size).toBeCloseTo(0.24, 10);
    const removed = burned(input(LIGHTNING_WATERMARK_PROFILE, { template: qrTemplate, includeQr: false }));
    expect(removed.layers.filter((layer) => layer.kind === "qr").map((layer) => layer.name)).toEqual(["Shop"]);
    const added = burned(input(LIGHTNING_WATERMARK_PROFILE, { template: creditTemplate(), includeQr: true, corner: "top-left" }));
    expect(added.layers.at(-1)).toMatchObject({ kind: "qr", slot: "profile", url: "https://www.tiktok.com/@jtbkk", position: { anchor: "top-left" } });
  });

  it("drops the template's handle when the caller turns it off, and adds the profile pill when the template has none", () => {
    const without = burned(input(LIGHTNING_WATERMARK_PROFILE, { template: creditTemplate(), includeHandle: false, includeQr: true, values: { credit: CREDIT } }));
    expect(without.layers.some((layer) => layer.kind === "text" && layer.items.some((item) => item.slot === "handle"))).toBe(false);
    expect(kinds(drawn(without))).toEqual(["scrim", "text", "qr"]);
    const creditOnly = savedTemplate([{ kind: "text", name: "Credit", items: [{ text: "", slot: "credit" }] }]);
    const added = burned(input(X_WATERMARK_PROFILE, { template: creditOnly, values: { ...watermarkSlotValues(X_WATERMARK_PROFILE), credit: CREDIT } }));
    expect(added.layers.map((layer) => layer.name)).toEqual(["Credit", "Handle"]);
    expect(handleLayer(added).items[0]).toMatchObject({ text: "justinwtanner", font: "text" });
  });

  it("draws a reused card image in place of the QR code, or of the handle when only the handle burns", () => {
    const card = { artifactId: "card-image", aspect: 2 };
    const withQr = burned(input(X_WATERMARK_PROFILE, { includeQr: true, includeHandle: false, card }));
    expect(withQr.layers).toHaveLength(1);
    expect(withQr.layers[0]).toMatchObject({ kind: "image", artifactId: "card-image", position: { anchor: "bottom-right", space: "inset" }, opacity: X_WATERMARK_PROFILE.qrOpacity });
    expect(withQr.layers[0].kind === "image" && withQr.layers[0].size).toBeCloseTo(0.32, 10);
    const handleOnly = burned(input(X_WATERMARK_PROFILE, { card }));
    expect(handleOnly.layers[0]).toMatchObject({ kind: "image", artifactId: "card-image", position: { anchor: "center", x: 0.5, y: 0.33, space: "frame" } });
    expect(handleOnly.layers[0].kind === "image" && handleOnly.layers[0].size).toBeCloseTo(watermarkHandleHeight(X_WATERMARK_PROFILE, FRAME) * 2, 10);
  });
});
