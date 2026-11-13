import { graphicsCanvas, graphicsFrameRegions, type GraphicsFraming } from "./frame.js";
import { randomUUID } from "node:crypto";
import type { Engine } from "videobook-engine";
import { getApiKey } from "../api-key.js";
import { extractFrames } from "../captions/frames.js";
import type { CaptionMediaSource } from "../captions/source.js";
import { captionMediaSource } from "../captions/source.js";
import { cachedFrameRegions, frameRegionsAt, missingFrameTimes } from "../frame-regions.js";
import { queue } from "../queue.js";
import { GraphicsServiceError } from "./errors.js";
import type { GraphicsRect } from "./layout.js";
import type { GraphicsFrame } from "./model.js";
import type { GraphicsClearSpot, GraphicsCover, GraphicsPlacedLayer, GraphicsRegionFrame, GraphicsWindow } from "./placement.js";
import { graphicsClearSpot, graphicsLayerCovers, graphicsLayerWindow, graphicsPlacementTimes, graphicsUncheckedTimes } from "./placement.js";
import type { GraphicsLook } from "./service.js";
import { currentGraphics } from "./service.js";

export const GRAPHICS_REGIONS_JOB = "graphics_regions";

export type GraphicsPlacementInput = {
  layerId: string;
  box?: GraphicsRect;
  block?: GraphicsRect;
  avoid?: readonly GraphicsRect[];
};

type PlacementTarget = {
  source: CaptionMediaSource;
  frame: GraphicsFrame;
  framing: GraphicsFraming;
  layer: GraphicsPlacedLayer;
  window: GraphicsWindow;
  times: number[];
};

type GraphicsPlacement = {
  asset_id: string;
  layer_id: string;
  window: GraphicsWindow;
  times: number[];
  unchecked_times: number[];
  covers: GraphicsCover[];
  clear_spot: GraphicsClearSpot | null;
};

type GraphicsDetection = GraphicsPlacement & { detected: number; regions: GraphicsRegionFrame[] };

async function placementTarget(engine: Engine, artifactId: string, look: GraphicsLook, layerId: string): Promise<PlacementTarget> {
  const current = await currentGraphics(engine, artifactId, look);
  if (current.frame.aspect !== "original" && current.frame.fit === "blur") throw new GraphicsServiceError("invalid", "Face and text placement checks are unavailable on blurred fill.");
  const layer = current.document.layers.find((entry) => entry.id === layerId);
  if (!layer) throw new GraphicsServiceError("invalid", `Layer ${layerId} is not in these graphics. Save them first.`, { layer_id: layerId });
  if (layer.kind === "scrim") throw new GraphicsServiceError("invalid", "A shade spans the frame, so it has no spot to move to.", { layer_id: layerId });
  const window = graphicsLayerWindow(layer, current.source.durationSeconds);
  if (!window) throw new GraphicsServiceError("invalid", `Layer ${layerId} is never shown, so it covers nothing.`, { layer_id: layerId });
  return {
    source: current.source,
    frame: graphicsCanvas(current.source, current.frame),
    framing: current.frame,
    layer,
    window,
    times: graphicsPlacementTimes(window),
  };
}

function placementAnswer(engine: Engine, artifactId: string, target: PlacementTarget, input: GraphicsPlacementInput): GraphicsPlacement {
  const frames = graphicsFrameRegions(cachedFrameRegions(engine, target.source.mediaHash), target.source, target.framing);
  const unchecked = graphicsUncheckedTimes(target.times, frames);
  const box = input.box;
  const clearSpot = box && unchecked.length === 0
    ? graphicsClearSpot({ frame: target.frame, layer: target.layer, block: input.block ?? box, drawn: box, window: target.window, frames, avoid: input.avoid ?? [] })
    : null;
  return {
    asset_id: artifactId,
    layer_id: target.layer.id,
    window: target.window,
    times: target.times,
    unchecked_times: unchecked,
    covers: box ? graphicsLayerCovers(box, target.frame, target.window, frames) : [],
    clear_spot: clearSpot,
  };
}

export async function checkGraphicsPlacement(engine: Engine, artifactId: string, look: GraphicsLook, input: GraphicsPlacementInput): Promise<GraphicsPlacement> {
  if (!input.box) throw new GraphicsServiceError("invalid", "check_placement needs box, the layer's drawn box in frame pixels.");
  return placementAnswer(engine, artifactId, await placementTarget(engine, artifactId, look, input.layerId), input);
}

export async function detectGraphicsRegions(
  engine: Engine,
  bookId: string,
  artifactId: string,
  look: GraphicsLook,
  input: GraphicsPlacementInput,
): Promise<GraphicsDetection> {
  const target = await placementTarget(engine, artifactId, look, input.layerId);
  const missing = missingFrameTimes(engine, target.source.mediaHash, target.times);
  if (missing.length > 0) {
    if (!getApiKey("OPENAI_API_KEY")) {
      throw new GraphicsServiceError("not_ready", "Finding faces and on-screen text needs an OpenAI API key, and OPENAI_API_KEY is not set.");
    }
    await queue.enqueueAndWait(
      `graphics-regions-${artifactId}-${randomUUID()}`,
      { type: GRAPHICS_REGIONS_JOB, bookId, assetId: artifactId, mediaHash: target.source.mediaHash, times: missing },
    );
  }
  return { ...placementAnswer(engine, artifactId, target, input), detected: missing.length, regions: cachedFrameRegions(engine, target.source.mediaHash) };
}

export async function findGraphicsRegions(engine: Engine, assetId: string, mediaHash: string, times: readonly number[], signal: AbortSignal): Promise<number> {
  const source = await captionMediaSource(engine, assetId);
  if (source.mediaHash !== mediaHash) throw new Error("The video changed while its faces and text were being found. Try again.");
  await frameRegionsAt({
    engine,
    artifactId: assetId,
    mediaHash,
    times,
    frames: async (missing) => {
      const requests = missing.map((time, index) => ({ id: `f${index}`, time }));
      return (await extractFrames(source.path, requests, source.durationSeconds, signal)).map((frame) => frame.buffer);
    },
    apiKey: getApiKey("OPENAI_API_KEY"),
    signal,
  });
  return times.length;
}
