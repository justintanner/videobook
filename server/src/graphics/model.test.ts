import { describe, expect, it } from "vitest";
import { MAX_WATERMARK_FADE_SECONDS } from "../jobs/burn-watermark.js";
import type { GraphicsDocument } from "./model.js";
import {
  emptyGraphicsDocument,
  GRAPHICS_DOCUMENT_VERSION,
  graphicsDocumentFromLayers,
  graphicsFrame,
  MAX_GRAPHICS_FADE_SECONDS,
  parseGraphicsDocument,
} from "./model.js";

type JsonRecord = Record<string | number, unknown>;

function sample(): GraphicsDocument {
  return graphicsDocumentFromLayers([
    { kind: "scrim", edge: "bottom" },
    {
      kind: "text",
      items: [{ text: "ติดไฟแดง\r\nHow can you look this cool?", slot: "headline", accent: "brush" }, { slot: "credit", icon: "camera" }],
      plate: {},
    },
    { kind: "image", artifactId: "logo-1" },
    { kind: "qr", url: "https://example.com/watch", slot: null },
  ]);
}

function sampleJson(): JsonRecord {
  return JSON.parse(JSON.stringify(sample())) as JsonRecord;
}

function withValue(path: readonly (string | number)[], value: unknown): JsonRecord {
  const document = sampleJson();
  const parent = path.slice(0, -1).reduce<JsonRecord>((target, key) => target[key] as JsonRecord, document);
  parent[path[path.length - 1]] = value;
  return document;
}

function errorOf(value: unknown): string {
  const result = parseGraphicsDocument(value);
  if (result.ok) throw new Error("expected the document to be rejected");
  return result.error;
}

describe("graphics document model", () => {
  it("starts empty at version 1 and parses that empty document", () => {
    expect(emptyGraphicsDocument()).toEqual({ version: GRAPHICS_DOCUMENT_VERSION, layers: [], nextId: 1 });
    expect(GRAPHICS_DOCUMENT_VERSION).toBe(1);
    expect(parseGraphicsDocument(emptyGraphicsDocument())).toEqual({ ok: true, document: emptyGraphicsDocument() });
  });

  it("mints layer and item ids from one counter and fills defaults for every kind", () => {
    const document = sample();
    expect(document.layers.map((layer) => layer.id)).toEqual(["l1", "l2", "l5", "l6"]);
    expect(document.nextId).toBe(7);
    const [scrim, text, image, qr] = document.layers;
    expect(scrim).toEqual({
      id: "l1", kind: "scrim", name: "Shade", visible: true, opacity: 1,
      timing: { start: null, end: null, tail: null, fade: 0, enter: "fade", exit: "fade" },
      edge: "bottom", height: 0.4, color: "#000000", strength: 0.7,
    });
    if (text.kind !== "text") throw new Error("expected a text layer");
    expect(text.items.map((item) => item.id)).toEqual(["t3", "t4"]);
    expect(text.items[0].text).toBe("ติดไฟแดง\nHow can you look this cool?");
    expect(text.items[1]).toMatchObject({ text: "", slot: "credit", font: "heavy", icon: "camera", maxLines: 2 });
    expect(text.plate).toEqual({ color: "#000000", opacity: 0.6, paddingX: 0.02, paddingY: 0.012, radius: 0.5, border: false });
    expect(text.position).toEqual({ anchor: "center", x: 0.5, y: 0.5, space: "safe" });
    expect(image).toMatchObject({ kind: "image", artifactId: "logo-1", size: 0.2, position: { anchor: "top-left", x: 0, y: 0, space: "safe" } });
    expect(qr).toMatchObject({ kind: "qr", style: "tile", level: "H", position: { anchor: "bottom-right", x: 1, y: 1, space: "inset" } });
    expect(graphicsDocumentFromLayers([{ kind: "text" }]).layers[0]).toMatchObject({ items: [{ id: "t2", text: "", slot: null }] });
  });

  it("accepts every layer kind and survives a JSON round trip", () => {
    const document = sample();
    expect(parseGraphicsDocument(document)).toEqual({ ok: true, document });
    expect(parseGraphicsDocument(JSON.parse(JSON.stringify(document)))).toEqual({ ok: true, document });
  });

  it("keeps empty slotted text and an empty QR URL when the QR fills the profile slot", () => {
    const document = withValue(["layers", 3, "slot"], "profile");
    (document.layers as JsonRecord[])[3].url = "";
    expect(parseGraphicsDocument(document).ok).toBe(true);
  });

  it.each([
    [["layers", 1, "opacity"], 0.01, "layers[1].opacity: Opacity must be between 0.05 and 1."],
    [["layers", 1, "position", "x"], 1.2, "layers[1].position.x: x must be between 0 and 1 of the positioning space."],
    [["layers", 2, "position", "y"], -0.1, "layers[2].position.y: y must be between 0 and 1 of the positioning space."],
    [["layers", 1, "items", 0, "size"], 0.31, "layers[1].items[0].size: Text size must be between 0.01 and 0.3 of the frame's short side."],
    [["layers", 1, "items", 0, "size"], 0.005, "layers[1].items[0].size: Text size must be between 0.01 and 0.3 of the frame's short side."],
    [["layers", 1, "width"], 0.05, "layers[1].width: Text width must be between 0.1 and 1 of the positioning space's width."],
    [["layers", 1, "gap"], 0.2, "layers[1].gap: Gap must be between 0 and 0.1 of the frame's short side."],
    [["layers", 2, "size"], 0.01, "layers[2].size: Image size must be between 0.02 and 1 of the frame's short side."],
    [["layers", 3, "size"], 0.7, "layers[3].size: QR size must be between 0.05 and 0.6 of the frame's short side."],
    [["layers", 0, "height"], 0.04, "layers[0].height: Scrim height must be between 0.05 and 1 of the frame height."],
    [["layers", 0, "strength"], 1.5, "layers[0].strength: Scrim strength must be between 0 and 1."],
    [["layers", 1, "timing", "fade"], 2.5, "layers[1].timing.fade: Fade must be between 0 and 2 seconds."],
    [["layers", 1, "timing", "start"], -1, "layers[1].timing.start: Start must be null or at least 0 seconds."],
    [["layers", 1, "timing", "end"], "soon", "layers[1].timing.end: End must be null or at least 0 seconds."],
    [["layers", 1, "timing", "tail"], -0.5, "layers[1].timing.tail: Tail must be null or at least 0 seconds."],
    [["layers", 1, "items", 0, "color"], "#FFF", "layers[1].items[0].color: Colours are #RRGGBB hex strings."],
    [["layers", 0, "color"], "black", "layers[0].color: Colours are #RRGGBB hex strings."],
    [["layers", 3, "url"], "ftp://example.com/file", "layers[3].url: QR URLs start with http:// or https:// and are at most 512 characters."],
    [["layers", 3, "url"], `https://example.com/${"a".repeat(500)}`, "layers[3].url: QR URLs start with http:// or https:// and are at most 512 characters."],
    [["layers", 3, "url"], "", "layers[3].url: A QR code needs an http or https URL unless it fills the profile slot."],
    [["layers", 1, "items", 0, "text"], "x".repeat(281), "layers[1].items[0].text: Text is limited to 280 characters."],
    [["layers", 1, "items", 0, "maxLines"], 7, "layers[1].items[0].maxLines: Max lines must be a whole number from 1 to 6."],
    [["layers", 1, "items", 0, "maxLines"], 1.5, "layers[1].items[0].maxLines: Max lines must be a whole number from 1 to 6."],
    [["layers", 1, "items"], [], "layers[1].items: A text layer holds 1 to 6 items."],
    [["layers", 1, "items", 0, "font"], "comic", "layers[1].items[0].font: Font preset must be one of heavy, display, text."],
    [["layers", 1, "items", 0, "slot"], "profile", "layers[1].items[0].slot: Text slot must be one of headline, secondary, credit, handle."],
    [["layers", 1, "items", 0, "icon"], "star", "layers[1].items[0].icon: Icon must be one of camera, link, music, pin, tiktok, x."],
    [["layers", 1, "position", "space"], "page", "layers[1].position.space: Space must be one of safe, inset, frame."],
    [["layers", 1, "visible"], "yes", "layers[1].visible: Visible must be true or false."],
    [["layers", 1, "name"], "n".repeat(81), "layers[1].name: Layer name is limited to 80 characters."],
    [["layers", 2, "id"], "layer-3", "layers[2].id: Layer ids look like l1."],
    [["layers", 2, "id"], "l1", "layers: Id l1 appears twice."],
    [["nextId"], 6, "nextId: nextId must be above 6, the highest id in use."],
    [["version"], 2, "version: Graphics documents are version 1."],
    [["layers", 1, "colour"], "#FFFFFF", "layers[1]: Unknown field \"colour\"."],
    [["extra"], true, "Unknown field \"extra\"."],
  ] as const)("rejects %j = %j with a readable message", (path, value, message) => {
    expect(errorOf(withValue(path, value))).toBe(message);
  });

  it("names an unknown layer kind and lists every problem", () => {
    expect(errorOf(withValue(["layers", 1, "kind"], "video"))).toMatch(/^layers\[1\](\.kind)?: Layer kind must be one of text, image, qr, scrim\.$/u);
    const document = withValue(["layers", 1, "opacity"], 2);
    (document.layers as JsonRecord[])[0].strength = -1;
    const result = parseGraphicsDocument(document);
    expect(result.ok ? [] : result.issues).toEqual([
      "layers[0].strength: Scrim strength must be between 0 and 1.",
      "layers[1].opacity: Opacity must be between 0.05 and 1.",
    ]);
  });

  it("limits a document to 24 layers and a text layer to 6 items", () => {
    const shades = Array.from({ length: 25 }, () => ({ kind: "scrim" as const }));
    expect(errorOf(graphicsDocumentFromLayers(shades))).toBe("layers: A document holds at most 24 layers.");
    expect(parseGraphicsDocument(graphicsDocumentFromLayers(shades.slice(1))).ok).toBe(true);
    const crowded = graphicsDocumentFromLayers([{ kind: "text", items: Array.from({ length: 7 }, () => ({})) }]);
    expect(errorOf(crowded)).toBe("layers[0].items: A text layer holds 1 to 6 items.");
  });

  it("validates frames and shares the watermark burn's fade limit", () => {
    expect(graphicsFrame({ width: 1080, height: 1920 })).toEqual({ width: 1080, height: 1920 });
    expect(() => graphicsFrame({ width: 0, height: 1920 })).toThrow("width: Frame sides must be whole numbers from 1 to 16384 pixels.");
    expect(() => graphicsFrame({ width: 1080.5, height: 1920 })).toThrow(/Frame sides/u);
    expect(MAX_GRAPHICS_FADE_SECONDS).toBe(MAX_WATERMARK_FADE_SECONDS);
  });
});

it("defaults legacy timing to fades and rejects words on non-text layers", () => {
  const document = graphicsDocumentFromLayers([{ kind: "scrim" }, { kind: "text", items: [{ text: "Title" }] }]);
  const legacy = { ...document, layers: document.layers.map((layer) => ({ ...layer, timing: { start: null, end: null, tail: null, fade: 0 } })) };
  expect(parseGraphicsDocument(legacy)).toEqual({ ok: true, document });
  for (const edge of ["enter", "exit"] as const) {
    const invalid = { ...document, layers: document.layers.map((layer) => ({ ...layer, timing: { ...layer.timing, [edge]: "words" } })) };
    expect(parseGraphicsDocument(invalid)).toMatchObject({ ok: false, error: expect.stringContaining("only available for text") });
  }
});
