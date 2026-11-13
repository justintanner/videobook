import { describe, expect, it } from "vitest";
import type { GraphicsLayerLayout, GraphicsRect } from "./layout.js";
import type { GraphicsImageLayer } from "./model.js";
import { graphicsDocumentFromLayers } from "./model.js";
import type { GraphicsRegion, GraphicsRegionFrame } from "./placement.js";
import {
  graphicsAvoidBoxes,
  graphicsClearSpot,
  graphicsDrawnBox,
  graphicsLayerCovers,
  graphicsLayerWindow,
  graphicsPlacementTimes,
  graphicsUncheckedTimes,
} from "./placement.js";

const FRAME = { width: 1000, height: 1000 };
const WHOLE = { start: 0, end: 4 };
const FACE_BOTTOM_LEFT: GraphicsRegion = { kind: "face", confidence: 0.9, x: 0.05, y: 0.82, width: 0.15, height: 0.15 };
const TEXT_BOTTOM_RIGHT: GraphicsRegion = { kind: "text", confidence: 0.8, x: 0.75, y: 0.85, width: 0.2, height: 0.1 };
const BOTTOM_LEFT: GraphicsRect = { x: 0, y: 800, width: 300, height: 200 };

function frames(...regions: GraphicsRegion[][]): GraphicsRegionFrame[] {
  return regions.map((list, index) => ({ time: 0.5 + index, regions: list }));
}

function imageLayer(anchor: "bottom-left" | "top-right" = "bottom-left"): GraphicsImageLayer {
  const point = anchor === "bottom-left" ? { x: 0, y: 1 } : { x: 1, y: 0 };
  const layer = graphicsDocumentFromLayers([{ kind: "image", artifactId: "logo", position: { anchor, ...point, space: "frame" } }]).layers[0];
  if (layer.kind !== "image") throw new Error("expected an image layer");
  return layer;
}

describe("graphics placement", () => {
  it("samples a layer's window about once a second, at most eight frames, on the frame-region buckets", () => {
    expect(graphicsPlacementTimes({ start: 0, end: 3 })).toEqual([0.5, 1.5, 2.5]);
    expect(graphicsPlacementTimes({ start: 9, end: 12 })).toEqual([9.5, 10.5, 11.5]);
    expect(graphicsPlacementTimes({ start: 0, end: 20 })).toEqual([1.25, 3.75, 6.25, 8.75, 11.25, 13.75, 16.25, 18.75]);
    expect(graphicsPlacementTimes({ start: 2.9, end: 3 })).toEqual([3]);
    expect(graphicsPlacementTimes({ start: 0.1, end: 0.6 })).toEqual([0.25]);
  });

  it("knows which sampled frames were never checked, matching cached frames by bucket", () => {
    const cached = [{ time: 0.5, regions: [] }, { time: 1.6, regions: [] }];
    expect(graphicsUncheckedTimes([0.5, 1.5, 2.5], cached)).toEqual([2.5]);
    expect(graphicsUncheckedTimes([0.5, 1.5], cached)).toEqual([]);
  });

  it("resolves the window a layer is shown in", () => {
    const layer = graphicsDocumentFromLayers([{ kind: "image", artifactId: "logo", timing: { start: null, end: null, tail: 3, fade: 0 } }]).layers[0];
    expect(graphicsLayerWindow(layer, 10)).toEqual({ start: 7, end: 10 });
    expect(graphicsLayerWindow(layer, 0)).toBeNull();
  });

  it("reports the faces and text a drawn box covers inside its window only", () => {
    const cached = frames([FACE_BOTTOM_LEFT, TEXT_BOTTOM_RIGHT], [{ ...FACE_BOTTOM_LEFT, confidence: 0.2 }], [{ ...FACE_BOTTOM_LEFT, kind: "graphic" }], [FACE_BOTTOM_LEFT]);
    expect(graphicsLayerCovers(BOTTOM_LEFT, FRAME, WHOLE, cached)).toEqual([{ kind: "face", time: 0.5 }, { kind: "face", time: 3.5 }]);
    expect(graphicsLayerCovers(BOTTOM_LEFT, FRAME, { start: 1, end: 3 }, cached)).toEqual([]);
    expect(graphicsLayerCovers({ x: 700, y: 800, width: 300, height: 200 }, FRAME, WHOLE, cached)).toEqual([{ kind: "text", time: 0.5 }]);
    expect(graphicsLayerCovers({ x: 180, y: 800, width: 300, height: 200 }, FRAME, WHOLE, cached)).toEqual([]);
  });

  it("measures text by its drawn lines, icon, accent or plate, and leaves out shades and missing images", () => {
    const line = (x: number, y: number, width: number) => ({ x, y, width, height: 40, text: "t", baseline: y + 30 });
    const item = { words: [], itemId: "t1", font: { family: "Montserrat", weight: 800, size: 40 }, box: { x: 0, y: 0, width: 900, height: 200 }, icon: null, accent: null, overflow: false };
    const text: GraphicsLayerLayout = {
      kind: "text",
      layerId: "l1",
      box: { x: 50, y: 700, width: 900, height: 200 },
      plate: null,
      overflow: false,
      items: [{ ...item, lines: [line(50, 700, 200), line(50, 740, 320)] }, { ...item, itemId: "t2", lines: [], accent: { x: 50, y: 790, width: 120, height: 8 } }],
    };
    expect(graphicsDrawnBox(text)).toEqual({ x: 50, y: 700, width: 320, height: 98 });
    expect(graphicsDrawnBox({ ...text, plate: { x: 40, y: 690, width: 400, height: 120, radius: 8 } })).toStrictEqual({ x: 40, y: 690, width: 400, height: 120 });
    expect(graphicsDrawnBox({ ...text, items: [{ ...item, lines: [] }] })).toBeNull();
    expect(graphicsDrawnBox({ kind: "scrim", layerId: "l2", box: { x: 0, y: 500, width: 1000, height: 500 } })).toBeNull();
    expect(graphicsDrawnBox({ kind: "image", layerId: "l3", box: BOTTOM_LEFT, missing: true })).toBeNull();
    expect(graphicsDrawnBox({ kind: "image", layerId: "l3", box: BOTTOM_LEFT, missing: false })).toStrictEqual(BOTTOM_LEFT);
    expect(graphicsDrawnBox({ kind: "qr", layerId: "l4", box: BOTTOM_LEFT, tile: { ...BOTTOM_LEFT, radius: 4 }, modules: BOTTOM_LEFT })).toStrictEqual(BOTTOM_LEFT);
  });

  it("moves a layer off a face to the clearest preferred anchor, keeping off text and other layers", () => {
    const layer = imageLayer();
    const input = { frame: FRAME, layer, block: BOTTOM_LEFT, drawn: BOTTOM_LEFT, window: WHOLE, avoid: [] };
    const onlyFace = graphicsClearSpot({ ...input, frames: frames([FACE_BOTTOM_LEFT]) });
    expect(onlyFace).toEqual({ position: { anchor: "bottom-right", x: 1, y: 1, space: "frame" }, moved: true, covers: [] });
    const faceAndText = graphicsClearSpot({ ...input, frames: frames([FACE_BOTTOM_LEFT, TEXT_BOTTOM_RIGHT]) });
    expect(faceAndText.position).toEqual({ anchor: "top-left", x: 0, y: 0, space: "frame" });
    const crowded = graphicsClearSpot({ ...input, frames: frames([FACE_BOTTOM_LEFT, TEXT_BOTTOM_RIGHT]), avoid: [{ x: 0, y: 0, width: 300, height: 200 }] });
    expect(crowded.position.anchor).toBe("top-right");
  });

  it("moves the block and keeps the drawn part where it sits inside it", () => {
    const layer = imageLayer();
    const block = { x: 0, y: 700, width: 900, height: 300 };
    const drawn = { x: 0, y: 800, width: 250, height: 200 };
    const spot = graphicsClearSpot({ frame: FRAME, layer, block, drawn, window: WHOLE, frames: frames([FACE_BOTTOM_LEFT]), avoid: [] });
    expect(spot).toMatchObject({ moved: true, covers: [] });
    expect(spot.position.anchor).toBe("top-left");
  });

  it("stays put when the layer is already clear or nothing is clearer, and reports what it still covers", () => {
    const clear = graphicsClearSpot({ frame: FRAME, layer: imageLayer("top-right"), block: { x: 700, y: 0, width: 300, height: 200 }, drawn: { x: 700, y: 0, width: 300, height: 200 }, window: WHOLE, frames: frames([FACE_BOTTOM_LEFT]), avoid: [] });
    expect(clear).toEqual({ position: { anchor: "top-right", x: 1, y: 0, space: "frame" }, moved: false, covers: [] });
    const everyAnchor = [0, 0.35, 0.7].flatMap((x) => [0, 0.4, 0.8].map((y): GraphicsRegion => ({ kind: "face", confidence: 0.9, x: x + 0.05, y: y + 0.05, width: 0.1, height: 0.1 })));
    const stuck = graphicsClearSpot({ frame: FRAME, layer: imageLayer(), block: BOTTOM_LEFT, drawn: BOTTOM_LEFT, window: WHOLE, frames: frames(everyAnchor), avoid: [] });
    expect(stuck).toEqual({ position: imageLayer().position, moved: false, covers: [{ kind: "face", time: 0.5 }] });
  });

  it("avoids the other layers shown at the same time", () => {
    const document = graphicsDocumentFromLayers([
      { kind: "scrim" },
      { kind: "image", artifactId: "a", timing: { start: 0, end: 2, tail: null, fade: 0 } },
      { kind: "image", artifactId: "b", timing: { start: 3, end: 4, tail: null, fade: 0 } },
      { kind: "image", artifactId: "c", visible: false },
      { kind: "image", artifactId: "d" },
    ]);
    const first = document.layers[1];
    const always = document.layers[4];
    const layout: GraphicsLayerLayout[] = document.layers.map((layer, index) => (
      layer.kind === "scrim"
        ? { kind: "scrim", layerId: layer.id, box: { x: 0, y: 500, width: 1000, height: 500 } }
        : { kind: "image", layerId: layer.id, box: { x: index * 100, y: 0, width: 50, height: 50 }, missing: false }
    ));
    expect(graphicsAvoidBoxes(document, layout, first.id, 4)).toEqual([{ x: 400, y: 0, width: 50, height: 50 }]);
    expect(graphicsAvoidBoxes(document, layout, always.id, 4)).toEqual([{ x: 100, y: 0, width: 50, height: 50 }, { x: 200, y: 0, width: 50, height: 50 }]);
  });
});
