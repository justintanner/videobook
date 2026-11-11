import type { LightningWatermarkProfile } from "../lightning-defaults.js";
import type { OsgPosition } from "../remotion/subtitles/types.js";
import type {
  GraphicsDocument,
  GraphicsFrame,
  GraphicsImageLayer,
  GraphicsLayer,
  GraphicsLayerInput,
  GraphicsQrLayer,
  GraphicsTextLayer,
  GraphicsTiming,
} from "./model.js";
import { appendGraphicsLayers, graphicsDocumentFromLayers } from "./model.js";
import type { GraphicsSlotValues } from "./slots.js";
import { fillGraphicsSlots } from "./slots.js";
import { platformWatermarkDocument } from "./starters.js";
import type { WatermarkDocumentOverrides, WatermarkWindow } from "./watermark-profile.js";
import { watermarkHandleHeight, watermarkLayerInputs } from "./watermark-profile.js";

export type WatermarkPatch = "position" | "scale" | "qrOpacity" | "handleOpacity" | "qrTiming" | "handleTiming" | "fade" | "handleStyle";
export type WatermarkCard = { artifactId: string; aspect: number };

export type WatermarkBurnInput = {
  profile: LightningWatermarkProfile;
  frame: GraphicsFrame;
  includeQr: boolean;
  includeHandle: boolean;
  corner: OsgPosition;
  qrWindow: WatermarkWindow;
  handleWindow: WatermarkWindow;
  values: GraphicsSlotValues;
  template: GraphicsDocument | null;
  patches: readonly WatermarkPatch[];
  card: WatermarkCard | null;
};

type ProfileInputs = { qr: GraphicsLayerInput | null; handle: GraphicsLayerInput | null };
type ProfileLayers = { qr: GraphicsQrLayer | null; handle: GraphicsTextLayer | null };

const MIN_IMAGE_SIZE = 0.02;
const MAX_IMAGE_SIZE = 1;

function isProfileQr(layer: GraphicsLayer): layer is GraphicsQrLayer {
  return layer.kind === "qr" && layer.slot === "profile";
}

function holdsHandle(layer: GraphicsLayer): layer is GraphicsTextLayer {
  return layer.kind === "text" && layer.items.some((item) => item.slot === "handle");
}

function onlyHandle(layer: GraphicsLayer): layer is GraphicsTextLayer {
  return layer.kind === "text" && layer.items.every((item) => item.slot === "handle");
}

export function watermarkTemplateDraws(template: GraphicsDocument): { qr: boolean; handle: boolean; credit: boolean } {
  return {
    qr: template.layers.some(isProfileQr),
    handle: template.layers.some(holdsHandle),
    credit: template.layers.some((layer) => layer.kind === "text" && layer.items.some((item) => item.slot === "credit")),
  };
}

function overrides(input: WatermarkBurnInput): WatermarkDocumentOverrides {
  return {
    includeQr: input.includeQr,
    includeHandle: input.includeHandle,
    corner: input.corner,
    qrWindow: input.qrWindow,
    handleWindow: input.handleWindow,
  };
}

function profileInputs(input: WatermarkBurnInput): ProfileInputs {
  const layers = watermarkLayerInputs(input.profile, input.frame, overrides(input));
  return { qr: layers.find((layer) => layer.kind === "qr") ?? null, handle: layers.find((layer) => layer.kind === "text") ?? null };
}

function profileLayers(inputs: ProfileInputs): ProfileLayers {
  const layers = graphicsDocumentFromLayers([inputs.qr, inputs.handle].flatMap((layer) => (layer ? [layer] : []))).layers;
  return {
    qr: layers.find((layer): layer is GraphicsQrLayer => layer.kind === "qr") ?? null,
    handle: layers.find((layer): layer is GraphicsTextLayer => layer.kind === "text") ?? null,
  };
}

function patchedTiming(current: GraphicsTiming, source: GraphicsTiming, window: boolean, fade: boolean): GraphicsTiming {
  return {
    ...current,
    ...(window ? { start: source.start, end: source.end, tail: source.tail } : {}),
    ...(fade ? { fade: source.fade } : {}),
  };
}

function patchedQr(layer: GraphicsQrLayer, source: GraphicsQrLayer | null, patches: ReadonlySet<WatermarkPatch>): GraphicsQrLayer {
  if (!source) return layer;
  return {
    ...layer,
    ...(patches.has("position") ? { position: source.position } : {}),
    ...(patches.has("scale") ? { size: source.size } : {}),
    ...(patches.has("qrOpacity") ? { opacity: source.opacity } : {}),
    timing: patchedTiming(layer.timing, source.timing, patches.has("qrTiming"), patches.has("fade")),
  };
}

function restyledHandle(layer: GraphicsTextLayer, source: GraphicsTextLayer): GraphicsTextLayer {
  return {
    ...layer,
    position: source.position,
    width: source.width,
    align: source.align,
    gap: source.gap,
    plate: source.plate,
    items: layer.items.map((item) => ({ ...source.items[0], id: item.id, text: item.text })),
  };
}

function patchedHandle(layer: GraphicsTextLayer, source: GraphicsTextLayer | null, patches: ReadonlySet<WatermarkPatch>): GraphicsTextLayer {
  if (!source) return layer;
  const styled = patches.has("handleStyle") && onlyHandle(layer) ? restyledHandle(layer, source) : layer;
  return {
    ...styled,
    ...(patches.has("handleOpacity") ? { opacity: source.opacity } : {}),
    timing: patchedTiming(layer.timing, source.timing, patches.has("handleTiming"), patches.has("fade")),
  };
}

function patchedLayer(layer: GraphicsLayer, sources: ProfileLayers, patches: ReadonlySet<WatermarkPatch>): GraphicsLayer {
  if (isProfileQr(layer)) return patchedQr(layer, sources.qr, patches);
  if (holdsHandle(layer)) return patchedHandle(layer, sources.handle, patches);
  return layer;
}

function withoutHandles(layers: readonly GraphicsLayer[]): GraphicsLayer[] {
  return layers.flatMap((layer): GraphicsLayer[] => {
    if (layer.kind !== "text") return [layer];
    const items = layer.items.filter((item) => item.slot !== "handle");
    if (items.length === layer.items.length) return [layer];
    return items.length > 0 ? [{ ...layer, items }] : [];
  });
}

function missingLayers(layers: readonly GraphicsLayer[], input: WatermarkBurnInput, inputs: ProfileInputs): GraphicsLayerInput[] {
  return [
    ...(input.includeQr && inputs.qr && !layers.some(isProfileQr) ? [inputs.qr] : []),
    ...(input.includeHandle && inputs.handle && !layers.some(holdsHandle) ? [inputs.handle] : []),
  ];
}

function patchedTemplate(template: GraphicsDocument, input: WatermarkBurnInput): GraphicsDocument {
  const inputs = profileInputs(input);
  const sources = profileLayers(inputs);
  const patches = new Set(input.patches);
  const patched = template.layers
    .filter((layer) => input.includeQr || !isProfileQr(layer))
    .map((layer) => patchedLayer(layer, sources, patches));
  const layers = input.includeHandle ? patched : withoutHandles(patched);
  return appendGraphicsLayers({ ...template, layers }, missingLayers(layers, input, inputs));
}

function imageSize(height: number, aspect: number): number {
  return Math.min(MAX_IMAGE_SIZE, Math.max(MIN_IMAGE_SIZE, height * aspect));
}

function cardLayer(layer: GraphicsQrLayer | GraphicsTextLayer, card: WatermarkCard, height: number): GraphicsImageLayer {
  return {
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    timing: layer.timing,
    kind: "image",
    artifactId: card.artifactId,
    position: layer.position,
    size: imageSize(height, card.aspect),
  };
}

function withCard(document: GraphicsDocument, input: WatermarkBurnInput, card: WatermarkCard): GraphicsDocument {
  const handleHeight = watermarkHandleHeight(input.profile, input.frame);
  const layers = document.layers.map((layer) => {
    if (input.includeQr && isProfileQr(layer)) return cardLayer(layer, card, layer.size);
    if (!input.includeQr && onlyHandle(layer)) return cardLayer(layer, card, handleHeight);
    return layer;
  });
  return { ...document, layers };
}

function drawsTitle(layer: GraphicsLayer): boolean {
  return layer.visible && layer.kind === "text" && layer.items.some((item) => item.slot !== "handle" && item.text.trim().length > 0);
}

export function watermarkDrawnDocument(document: GraphicsDocument): GraphicsDocument {
  if (document.layers.some(drawsTitle)) return document;
  return { ...document, layers: document.layers.filter((layer) => layer.kind !== "scrim") };
}

export function watermarkLookDocument(input: WatermarkBurnInput): GraphicsDocument {
  const base = input.template
    ? patchedTemplate(input.template, input)
    : platformWatermarkDocument(input.profile, input.frame, overrides(input));
  const filled = fillGraphicsSlots(base, input.values, { overwrite: true });
  return input.card ? withCard(filled, input, input.card) : filled;
}

export function watermarkBurnDocument(input: WatermarkBurnInput): GraphicsDocument {
  return watermarkDrawnDocument(watermarkLookDocument(input));
}
