import { describe, expect, it } from "vitest";
import type { GraphicsDocument, GraphicsLayer } from "./model.js";
import { graphicsDocumentFromLayers, parseGraphicsDocument } from "./model.js";
import { fillGraphicsSlots, graphicsSlotValues, writeGraphicsSlot } from "./slots.js";

function document(): GraphicsDocument {
  return graphicsDocumentFromLayers([
    { kind: "text", items: [{ slot: "headline", text: "" }, { slot: "secondary", text: "Typed line" }, { text: "Free text" }] },
    { kind: "text", items: [{ slot: "headline", text: "Second headline" }, { slot: "handle", text: "" }] },
    { kind: "qr", slot: "profile", url: "" },
    { kind: "qr", slot: null, url: "https://example.com/fixed" },
  ]);
}

function texts(layers: readonly GraphicsLayer[]): string[] {
  return layers.flatMap((layer) => {
    if (layer.kind === "text") return layer.items.map((item) => item.text);
    return layer.kind === "qr" ? [layer.url] : [];
  });
}

describe("graphics slots", () => {
  it("reads the first non-empty value of every slot that a layer holds", () => {
    expect(graphicsSlotValues(document())).toEqual({
      headline: "Second headline",
      secondary: "Typed line",
      handle: "",
      profile: "",
    });
    expect(graphicsSlotValues(graphicsDocumentFromLayers([{ kind: "scrim" }]))).toEqual({});
  });

  it("fills empty slots without touching typed text unless asked to overwrite", () => {
    const values = { headline: "Filled headline", secondary: "Filled line", handle: "jtbkk", credit: "TikTok/@pomkondeena", profile: "https://www.tiktok.com/@jtbkk" };
    const kept = fillGraphicsSlots(document(), values, { overwrite: false });
    expect(texts(kept.layers)).toEqual([
      "Filled headline", "Typed line", "Free text",
      "Second headline", "jtbkk",
      "https://www.tiktok.com/@jtbkk", "https://example.com/fixed",
    ]);
    const overwritten = fillGraphicsSlots(document(), values, { overwrite: true });
    expect(texts(overwritten.layers)).toEqual([
      "Filled headline", "Filled line", "Free text",
      "Filled headline", "jtbkk",
      "https://www.tiktok.com/@jtbkk", "https://example.com/fixed",
    ]);
    expect(parseGraphicsDocument(overwritten).ok).toBe(true);
  });

  it("never fills an empty, blank, over-long or non-web value", () => {
    const filled = fillGraphicsSlots(document(), {
      headline: "",
      secondary: "   ",
      handle: "h".repeat(281),
      profile: "javascript:alert(1)",
    }, { overwrite: true });
    expect(filled).toEqual(document());
  });

  it("writes one slot everywhere it appears, even to an empty value", () => {
    const written = writeGraphicsSlot(document(), "headline", "");
    expect(texts(written.layers).slice(0, 5)).toEqual(["", "Typed line", "Free text", "", ""]);
    const original = document();
    writeGraphicsSlot(original, "secondary", "Changed");
    expect(original).toEqual(document());
  });
});
