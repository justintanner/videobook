import type { GraphicsDocument, GraphicsLayer } from "./model.js";
import type { ResolvedGraphicsTiming } from "./timing.js";
import { resolveLayerTiming } from "./timing.js";

export type GraphicsStillGroup = { layerIds: string[]; timing: ResolvedGraphicsTiming };

function drawsSomething(layer: GraphicsLayer): boolean {
  if (!layer.visible) return false;
  if (layer.kind === "text") return layer.items.some((item) => item.text.trim().length > 0);
  if (layer.kind === "qr") return layer.url.length > 0;
  if (layer.kind === "scrim") return layer.strength > 0;
  return true;
}

function sameTiming(left: ResolvedGraphicsTiming, right: ResolvedGraphicsTiming): boolean {
  return left.start === right.start && left.end === right.end && left.fadeIn === right.fadeIn && left.fadeOut === right.fadeOut;
}

export function graphicsStillGroups(document: GraphicsDocument, durationSeconds: number): GraphicsStillGroup[] {
  return document.layers.reduce<GraphicsStillGroup[]>((groups, layer) => {
    const timing = drawsSomething(layer) ? resolveLayerTiming(layer.timing, durationSeconds) : null;
    if (!timing) return groups;
    const last = groups.at(-1);
    if (last && sameTiming(last.timing, timing)) {
      return [...groups.slice(0, -1), { layerIds: [...last.layerIds, layer.id], timing: last.timing }];
    }
    return [...groups, { layerIds: [layer.id], timing }];
  }, []);
}
