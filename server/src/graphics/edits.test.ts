import { describe, expect, it } from "vitest";
import type { GraphicsEdit, GraphicsEditError } from "./edits.js";
import { applyGraphicsEdits } from "./edits.js";
import type { GraphicsDocument, GraphicsLayer, GraphicsQrLayer, GraphicsTextLayer } from "./model.js";
import { emptyGraphicsDocument, graphicsDocumentFromLayers, parseGraphicsDocument } from "./model.js";
import { GRAPHICS_STARTERS } from "./starters.js";

function base(): GraphicsDocument {
  return graphicsDocumentFromLayers([
    { kind: "scrim", edge: "bottom" },
    { kind: "text", name: "Title", items: [{ text: "Typed headline", slot: "headline" }, { text: "", slot: "secondary" }] },
    { kind: "image", artifactId: "logo-1" },
    { kind: "qr", url: "", slot: "profile" },
  ]);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function applied(document: GraphicsDocument, edits: GraphicsEdit[]): GraphicsDocument {
  const result = applyGraphicsEdits(deepFreeze(document), edits);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  expect(parseGraphicsDocument(result.document)).toEqual({ ok: true, document: result.document });
  return result.document;
}

function failed(document: GraphicsDocument, edits: GraphicsEdit[]): GraphicsEditError {
  const result = applyGraphicsEdits(deepFreeze(document), edits);
  if (result.ok) throw new Error("expected the edits to fail");
  return result.error;
}

function layer(document: GraphicsDocument, id: string): GraphicsLayer {
  const found = document.layers.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

function textLayer(document: GraphicsDocument, id: string): GraphicsTextLayer {
  const found = layer(document, id);
  if (found.kind !== "text") throw new Error(`${id} is not text`);
  return found;
}

function qrLayer(document: GraphicsDocument, id: string): GraphicsQrLayer {
  const found = layer(document, id);
  if (found.kind !== "qr") throw new Error(`${id} is not a QR layer`);
  return found;
}

const ids = (document: GraphicsDocument) => document.layers.map((candidate) => candidate.id);

describe("graphics edits", () => {
  it("never mutates the input document", () => {
    const document = base();
    const before = JSON.stringify(document);
    const edits: GraphicsEdit[] = [
      { op: "set_item", layer_id: "l2", item_id: "t3", item: { text: "New" } },
      { op: "set_position", layer_id: "l2", position: { y: 0.8 } },
      { op: "move_layer", layer_id: "l1", index: 3 },
      { op: "apply_template", template: GRAPHICS_STARTERS[1].build({ width: 1080, height: 1920 }) },
    ];
    const result = applyGraphicsEdits(document, edits);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(document)).toBe(before);
  });

  it("add_layer adds a layer with fresh ids at the top or at an index", () => {
    const document = applied(base(), [
      { op: "add_layer", layer: { kind: "text", items: [{ text: "Hello", slot: "credit" }] } },
      { op: "add_layer", layer: { kind: "scrim", edge: "top" }, index: 0 },
    ]);
    expect(ids(document)).toEqual(["l9", "l1", "l2", "l5", "l6", "l7"]);
    expect(textLayer(document, "l7").items).toMatchObject([{ id: "t8", text: "Hello", slot: "credit" }]);
    expect(layer(document, "l9")).toMatchObject({ kind: "scrim", edge: "top" });
    expect(document.nextId).toBe(10);
    expect(failed(base(), [{ op: "add_layer", layer: { kind: "scrim" }, index: 9 }])).toMatchObject({ code: "bad_index", index: 0 });
    const full = graphicsDocumentFromLayers(Array.from({ length: 24 }, () => ({ kind: "scrim" as const })));
    expect(failed(full, [{ op: "add_layer", layer: { kind: "scrim" } }])).toMatchObject({ code: "layer_limit" });
  });

  it("remove_layer drops the layer and never reuses its id", () => {
    const document = applied(base(), [
      { op: "remove_layer", layer_id: "l2" },
      { op: "add_layer", layer: { kind: "scrim" } },
    ]);
    expect(ids(document)).toEqual(["l1", "l5", "l6", "l7"]);
    expect(failed(base(), [{ op: "remove_layer", layer_id: "l99" }])).toEqual({
      code: "unknown_layer",
      message: "Layer l99 is not in these graphics.",
      index: 0,
      op: "remove_layer",
    });
  });

  it("duplicate_layer copies a layer right above it with new layer and item ids", () => {
    const document = applied(base(), [{ op: "duplicate_layer", layer_id: "l2" }]);
    expect(ids(document)).toEqual(["l1", "l2", "l7", "l5", "l6"]);
    const copy = textLayer(document, "l7");
    expect(copy.name).toBe("Title copy");
    expect(copy.items.map((item) => [item.id, item.text, item.slot])).toEqual([["t8", "Typed headline", "headline"], ["t9", "", "secondary"]]);
    expect(document.nextId).toBe(10);
  });

  it("move_layer reorders layers bottom to top", () => {
    const document = applied(base(), [{ op: "move_layer", layer_id: "l1", index: 3 }]);
    expect(ids(document)).toEqual(["l2", "l5", "l6", "l1"]);
    expect(failed(base(), [{ op: "move_layer", layer_id: "l1", index: 4 }])).toMatchObject({
      code: "bad_index",
      message: "Layer index must be a whole number from 0 to 3.",
    });
  });

  it("set_layer renames, hides and fades a layer", () => {
    const document = applied(base(), [{ op: "set_layer", layer_id: "l5", layer: { name: "Logo", visible: false, opacity: 0.5 } }]);
    expect(layer(document, "l5")).toMatchObject({ name: "Logo", visible: false, opacity: 0.5, artifactId: "logo-1" });
    expect(failed(base(), [{ op: "set_layer", layer_id: "l5", layer: { opacity: 0.01 } }])).toEqual({
      code: "invalid",
      message: "layers[2].opacity: Opacity must be between 0.05 and 1.",
      index: 0,
      op: "set_layer",
    });
  });

  it("set_position merges into the layer position and refuses a scrim", () => {
    const document = applied(base(), [{ op: "set_position", layer_id: "l2", position: { anchor: "bottom-left", x: 0, y: 1 } }]);
    expect(textLayer(document, "l2").position).toEqual({ anchor: "bottom-left", x: 0, y: 1, space: "safe" });
    expect(failed(base(), [{ op: "set_position", layer_id: "l1", position: { x: 0.2 } }])).toMatchObject({ code: "wrong_kind" });
  });

  it("set_timing merges a partial window", () => {
    const document = applied(base(), [
      { op: "set_timing", layer_id: "l5", timing: { end: 3, fade: 0.3 } },
      { op: "set_timing", layer_id: "l6", timing: { tail: 2.3 } },
    ]);
    expect(layer(document, "l5").timing).toEqual({ start: null, end: 3, tail: null, fade: 0.3 });
    expect(layer(document, "l6").timing).toEqual({ start: null, end: null, tail: 2.3, fade: 0 });
    expect(failed(base(), [{ op: "set_timing", layer_id: "l5", timing: { fade: 3 } }])).toMatchObject({
      code: "invalid",
      message: "layers[2].timing.fade: Fade must be between 0 and 2 seconds.",
    });
  });

  it("set_text_block changes width, align, gap and the plate", () => {
    const document = applied(base(), [
      { op: "set_text_block", layer_id: "l2", block: { width: 0.6, align: "left", gap: 0.03, plate: { color: "#112233", radius: 1 } } },
    ]);
    expect(textLayer(document, "l2")).toMatchObject({
      width: 0.6,
      align: "left",
      gap: 0.03,
      plate: { color: "#112233", opacity: 0.6, paddingX: 0.02, paddingY: 0.012, radius: 1, border: false },
    });
    const cleared = applied(document, [{ op: "set_text_block", layer_id: "l2", block: { plate: null } }]);
    expect(textLayer(cleared, "l2").plate).toBeNull();
    expect(failed(base(), [{ op: "set_text_block", layer_id: "l5", block: { width: 0.5 } }])).toEqual({
      code: "wrong_kind",
      message: "Layer l5 is an image layer, not a text layer.",
      index: 0,
      op: "set_text_block",
    });
  });

  it("add_item appends or inserts an item with a fresh id", () => {
    const document = applied(base(), [
      { op: "add_item", layer_id: "l2", item: { text: "TikTok/@pomkondeena", slot: "credit", icon: "camera" } },
      { op: "add_item", layer_id: "l2", index: 0 },
    ]);
    expect(textLayer(document, "l2").items.map((item) => item.id)).toEqual(["t8", "t3", "t4", "t7"]);
    expect(textLayer(document, "l2").items[3]).toMatchObject({ text: "TikTok/@pomkondeena", slot: "credit", icon: "camera" });
    const full = graphicsDocumentFromLayers([{ kind: "text", items: Array.from({ length: 6 }, () => ({})) }]);
    expect(failed(full, [{ op: "add_item", layer_id: "l1" }])).toMatchObject({ code: "item_limit" });
    expect(failed(base(), [{ op: "add_item", layer_id: "l6" }])).toMatchObject({ code: "wrong_kind" });
  });

  it("remove_item drops an item but keeps at least one", () => {
    const document = applied(base(), [{ op: "remove_item", layer_id: "l2", item_id: "t4" }]);
    expect(textLayer(document, "l2").items.map((item) => item.id)).toEqual(["t3"]);
    expect(failed(document, [{ op: "remove_item", layer_id: "l2", item_id: "t3" }])).toMatchObject({ code: "last_item" });
    expect(failed(base(), [{ op: "remove_item", layer_id: "l2", item_id: "t9" }])).toEqual({
      code: "unknown_item",
      message: "Item t9 is not in layer l2.",
      index: 0,
      op: "remove_item",
    });
  });

  it("move_item reorders items inside a block", () => {
    const document = applied(base(), [{ op: "move_item", layer_id: "l2", item_id: "t4", index: 0 }]);
    expect(textLayer(document, "l2").items.map((item) => item.id)).toEqual(["t4", "t3"]);
    expect(failed(base(), [{ op: "move_item", layer_id: "l2", item_id: "t4", index: 2 }])).toMatchObject({ code: "bad_index" });
  });

  it("set_item changes item fields, keeps its id and normalises line breaks", () => {
    const document = applied(base(), [{
      op: "set_item",
      layer_id: "l2",
      item_id: "t4",
      item: { text: "ติดไฟแดง\r\nยังไง ", size: 0.045, font: "text", maxLines: 3, accent: "underline", outline: true },
    }]);
    expect(textLayer(document, "l2").items[1]).toMatchObject({
      id: "t4",
      text: "ติดไฟแดง\nยังไง ",
      size: 0.045,
      font: "text",
      maxLines: 3,
      accent: "underline",
      outline: true,
      slot: "secondary",
    });
    expect(failed(base(), [{ op: "set_item", layer_id: "l2", item_id: "t3", item: { size: 0.5 } }])).toMatchObject({
      code: "invalid",
      message: "layers[1].items[0].size: Text size must be between 0.01 and 0.3 of the frame's short side.",
    });
  });

  it("set_image swaps the artifact and resizes", () => {
    const document = applied(base(), [{ op: "set_image", layer_id: "l5", image: { artifactId: "logo-2", size: 0.3 } }]);
    expect(layer(document, "l5")).toMatchObject({ artifactId: "logo-2", size: 0.3 });
    expect(failed(base(), [{ op: "set_image", layer_id: "l2", image: { size: 0.3 } }])).toMatchObject({ code: "wrong_kind" });
  });

  it("set_qr changes the URL, slot and look of a QR layer", () => {
    const document = applied(base(), [{
      op: "set_qr",
      layer_id: "l6",
      qr: { url: "  https://www.tiktok.com/@jtbkk ", slot: null, style: "plain", dark: "#000000", light: "#EEEEEE", level: "Q", size: 0.2 },
    }]);
    expect(qrLayer(document, "l6")).toMatchObject({
      url: "https://www.tiktok.com/@jtbkk",
      slot: null,
      style: "plain",
      dark: "#000000",
      light: "#EEEEEE",
      level: "Q",
      size: 0.2,
    });
    expect(failed(base(), [{ op: "set_qr", layer_id: "l6", qr: { slot: null } }])).toMatchObject({
      code: "invalid",
      message: "layers[3].url: A QR code needs an http or https URL unless it fills the profile slot.",
    });
  });

  it("set_scrim changes the edge, height, colour and strength", () => {
    const document = applied(base(), [{ op: "set_scrim", layer_id: "l1", scrim: { edge: "top", height: 0.3, color: "#101010", strength: 0.5 } }]);
    expect(layer(document, "l1")).toMatchObject({ edge: "top", height: 0.3, color: "#101010", strength: 0.5 });
    expect(failed(base(), [{ op: "set_scrim", layer_id: "l2", scrim: { height: 0.3 } }])).toMatchObject({ code: "wrong_kind" });
  });

  it("set_slot_text fills every holder of a slot, including the QR profile URL", () => {
    const document = applied(base(), [
      { op: "duplicate_layer", layer_id: "l2" },
      { op: "set_slot_text", slot: "headline", text: "ติดไฟแดงยังไงให้เท่ได้ขนาดนี้" },
      { op: "set_slot_text", slot: "profile", text: " https://x.com/justinwtanner " },
    ]);
    expect(textLayer(document, "l2").items[0].text).toBe("ติดไฟแดงยังไงให้เท่ได้ขนาดนี้");
    expect(textLayer(document, "l7").items[0].text).toBe("ติดไฟแดงยังไงให้เท่ได้ขนาดนี้");
    expect(qrLayer(document, "l6").url).toBe("https://x.com/justinwtanner");
    expect(failed(base(), [{ op: "set_slot_text", slot: "credit", text: "TikTok/@pomkondeena" }])).toEqual({
      code: "unknown_slot",
      message: "No layer holds the credit slot.",
      index: 0,
      op: "set_slot_text",
    });
  });

  it("apply_template replaces the layers, keeps typed text by slot and mints ids above the old ones", () => {
    const template = GRAPHICS_STARTERS.find((starter) => starter.id === "lower-third")!.build({ width: 1080, height: 1920 });
    const document = applied(base(), [
      { op: "set_slot_text", slot: "secondary", text: "A second line" },
      { op: "apply_template", template },
    ]);
    expect(document.layers.map((candidate) => candidate.kind)).toEqual(["scrim", "text"]);
    expect(ids(document)).toEqual(["l7", "l8"]);
    const block = textLayer(document, "l8");
    expect(block.items.map((item) => [item.id, item.slot, item.text])).toEqual([
      ["t9", "headline", "Typed headline"],
      ["t10", "secondary", "A second line"],
      ["t11", "credit", ""],
    ]);
    expect(block.items[0]).toMatchObject({ size: 0.068, maxLines: 4, accent: "brush" });
    expect(document.nextId).toBe(12);
    const broken = { ...template, nextId: 0 };
    expect(failed(base(), [{ op: "apply_template", template: broken }])).toMatchObject({
      code: "invalid",
      message: "Template: nextId: nextId must be a whole number above 0.",
    });
  });

  it("reports the failing edit and keeps earlier edits out of a failed result", () => {
    const error = failed(base(), [
      { op: "set_layer", layer_id: "l1", layer: { name: "Bottom shade" } },
      { op: "set_item", layer_id: "l2", item_id: "t3", item: { color: "white" } },
    ]);
    expect(error).toEqual({
      code: "invalid",
      message: "layers[1].items[0].color: Colours are #RRGGBB hex strings.",
      index: 1,
      op: "set_item",
    });
  });

  it("validates the starting document and rejects unknown operations and kinds", () => {
    expect(applyGraphicsEdits(emptyGraphicsDocument(), [])).toEqual({ ok: true, document: emptyGraphicsDocument() });
    const broken = { ...base(), nextId: 2 };
    expect(failed(broken, [])).toEqual({
      code: "invalid",
      message: "nextId: nextId must be above 6, the highest id in use.",
      index: null,
      op: null,
    });
    const unknownOp = { op: "explode", layer_id: "l1" } as unknown as GraphicsEdit;
    expect(failed(base(), [unknownOp])).toMatchObject({ code: "invalid", message: "Unknown edit operation explode.", index: 0, op: "explode" });
    const unknownKind = { op: "add_layer", layer: { kind: "video" } } as unknown as GraphicsEdit;
    expect(failed(base(), [unknownKind])).toMatchObject({ code: "invalid", message: "Layer kind must be one of text, image, qr, scrim." });
  });
});

describe("graphics edits from untyped callers", () => {
  it("turns non-string text and URLs into schema errors instead of throwing", () => {
    const text = { op: "set_item", layer_id: "l2", item_id: "t3", item: { text: 42 } } as unknown as GraphicsEdit;
    expect(failed(base(), [text])).toMatchObject({ code: "invalid", message: "layers[1].items[0].text: Text must be a string." });
    const url = { op: "set_qr", layer_id: "l6", qr: { url: 7 } } as unknown as GraphicsEdit;
    expect(failed(base(), [url])).toMatchObject({ code: "invalid", message: "layers[3].url: QR URLs start with http:// or https:// and are at most 512 characters." });
    const slot = { op: "set_slot_text", slot: "profile", text: null } as unknown as GraphicsEdit;
    expect(failed(base(), [slot])).toMatchObject({ code: "invalid", index: 0 });
  });
});
