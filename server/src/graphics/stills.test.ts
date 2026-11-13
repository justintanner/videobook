import { describe, expect, it } from "vitest";
import { LIGHTNING_WATERMARK_PROFILE } from "../lightning-defaults.js";
import type { GraphicsDocument, GraphicsLayerInput, GraphicsScrimLayerInput, GraphicsTiming } from "./model.js";
import { graphicsDocumentFromLayers } from "./model.js";
import { GRAPHICS_STARTERS } from "./starters.js";
import { graphicsStillGroups } from "./stills.js";

const WHOLE: Partial<GraphicsTiming> = {};
const LAST_THREE: Partial<GraphicsTiming> = { tail: 3, fade: 0.5 };

function scrim(timing: Partial<GraphicsTiming>, fields: Omit<GraphicsScrimLayerInput, "kind" | "timing"> = {}): GraphicsLayerInput {
  return { kind: "scrim", timing, ...fields };
}

function text(value: string, timing: Partial<GraphicsTiming> = WHOLE): GraphicsLayerInput {
  return { kind: "text", timing, items: [{ text: value }] };
}

function document(layers: GraphicsLayerInput[]): GraphicsDocument {
  return graphicsDocumentFromLayers(layers);
}

describe("graphicsStillGroups", () => {
  it("splits matching windows when either motion preset differs", () => {
    const groups = graphicsStillGroups(document([
      text("Fade"), text("Slide", { enter: "slide" }), text("Pop", { enter: "slide", exit: "pop" }),
      text("Words", { enter: "words" }), text("More words", { enter: "words" }),
    ]), 8);
    expect(groups.map((group) => group.layerIds)).toEqual([["l1"], ["l3"], ["l5"], ["l7", "l9"]]);
  });

  it("gives layers A (whole clip), B (last 3 seconds) and C (whole clip) three groups in order", () => {
    const groups = graphicsStillGroups(document([scrim(WHOLE), text("Breaking", LAST_THREE), text("Credit")]), 8);
    expect(groups).toEqual([
      { layerIds: ["l1"], timing: { start: 0, end: 8, fadeIn: 0, fadeOut: 0, enter: "fade", exit: "fade" } },
      { layerIds: ["l2"], timing: { start: 5, end: 8, fadeIn: 0.5, fadeOut: 0, enter: "fade", exit: "fade" } },
      { layerIds: ["l4"], timing: { start: 0, end: 8, fadeIn: 0, fadeOut: 0, enter: "fade", exit: "fade" } },
    ]);
  });

  it("joins equal neighbours into one group", () => {
    expect(graphicsStillGroups(document([scrim(WHOLE), text("Title"), text("Credit")]), 8)).toEqual([
      { layerIds: ["l1", "l2", "l4"], timing: { start: 0, end: 8, fadeIn: 0, fadeOut: 0, enter: "fade", exit: "fade" } },
    ]);
    const sameWindow = graphicsStillGroups(document([text("One", { start: 5, fade: 0.5 }), text("Two", LAST_THREE)]), 8);
    expect(sameWindow.map((group) => group.layerIds)).toEqual([["l1", "l3"]]);
  });

  it("splits neighbours whose windows match but whose fades differ", () => {
    const groups = graphicsStillGroups(document([text("One", { tail: 3, fade: 0.5 }), text("Two", { tail: 3, fade: 0 })]), 8);
    expect(groups.map((group) => group.layerIds)).toEqual([["l1"], ["l3"]]);
  });

  it("skips hidden layers, layers with nothing to draw and empty windows, joining what remains", () => {
    const groups = graphicsStillGroups(document([
      text("Title"),
      scrim(WHOLE, { visible: false }),
      text("   "),
      { kind: "qr", url: "" },
      scrim(WHOLE, { strength: 0 }),
      text("Late", { start: 12 }),
      text("Credit"),
    ]), 8);
    expect(groups.map((group) => group.layerIds)).toEqual([["l1", "l10"]]);
  });

  it("returns no group for an empty document, a hidden document or a clip without duration", () => {
    expect(graphicsStillGroups(document([]), 8)).toEqual([]);
    expect(graphicsStillGroups(document([scrim(WHOLE, { visible: false })]), 8)).toEqual([]);
    expect(graphicsStillGroups(document([scrim(WHOLE)]), 0)).toEqual([]);
  });

  it("draws the default look as one still for the whole clip: its shade under the title block's handle", () => {
    const tiktok = GRAPHICS_STARTERS.find((starter) => starter.id === "tiktok-title");
    if (!tiktok) throw new Error("expected the tiktok-title starter");
    const groups = graphicsStillGroups(tiktok.build({ width: 1080, height: 1920 }), 8);
    expect(groups).toEqual([{ layerIds: ["l1", "l2"], timing: { start: 0, end: 8, fadeIn: 0, fadeOut: 0, enter: "fade", exit: "fade" } }]);
  });

  it("still draws the watermark starter's handle only for the profile's first seconds", () => {
    const watermark = GRAPHICS_STARTERS.find((starter) => starter.id === "watermark");
    if (!watermark) throw new Error("expected the watermark starter");
    const groups = graphicsStillGroups(watermark.build({ width: 1080, height: 1920 }), 8);
    expect(groups).toContainEqual({ layerIds: ["l2"], timing: { start: 0, end: 3, fadeIn: 0, fadeOut: LIGHTNING_WATERMARK_PROFILE.fadeSeconds, enter: "fade", exit: "fade" } });
  });
});
