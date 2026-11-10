import type {
  GraphicsDocument,
  GraphicsImageLayer,
  GraphicsLayer,
  GraphicsLayerInput,
  GraphicsPlate,
  GraphicsPosition,
  GraphicsQrLayer,
  GraphicsScrimLayer,
  GraphicsSlot,
  GraphicsTextItem,
  GraphicsTextItemInput,
  GraphicsTextLayer,
  GraphicsTiming,
} from "./model.js";
import {
  appendGraphicsLayers,
  createGraphicsLayer,
  DEFAULT_GRAPHICS_PLATE,
  definedFields,
  GRAPHICS_LAYER_KINDS,
  MAX_GRAPHICS_ITEMS,
  MAX_GRAPHICS_LAYERS,
  MAX_GRAPHICS_NAME_LENGTH,
  nextGraphicsId,
  normalizeGraphicsText,
  parseGraphicsDocument,
  textItemFrom,
} from "./model.js";
import { fillGraphicsSlots, graphicsSlotValues, writeGraphicsSlot } from "./slots.js";

type PlatePatch = Partial<GraphicsPlate> | null;

export type GraphicsEdit =
  | { op: "add_layer"; layer: GraphicsLayerInput; index?: number }
  | { op: "remove_layer"; layer_id: string }
  | { op: "duplicate_layer"; layer_id: string }
  | { op: "move_layer"; layer_id: string; index: number }
  | { op: "set_layer"; layer_id: string; layer: Partial<Pick<GraphicsLayer, "name" | "visible" | "opacity">> }
  | { op: "set_position"; layer_id: string; position: Partial<GraphicsPosition> }
  | { op: "set_timing"; layer_id: string; timing: Partial<GraphicsTiming> }
  | { op: "set_text_block"; layer_id: string; block: Partial<Pick<GraphicsTextLayer, "width" | "align" | "gap">> & { plate?: PlatePatch } }
  | { op: "add_item"; layer_id: string; item?: GraphicsTextItemInput; index?: number }
  | { op: "remove_item"; layer_id: string; item_id: string }
  | { op: "move_item"; layer_id: string; item_id: string; index: number }
  | { op: "set_item"; layer_id: string; item_id: string; item: GraphicsTextItemInput }
  | { op: "set_image"; layer_id: string; image: Partial<Pick<GraphicsImageLayer, "artifactId" | "size">> }
  | { op: "set_qr"; layer_id: string; qr: Partial<Pick<GraphicsQrLayer, "url" | "slot" | "size" | "style" | "dark" | "light" | "level">> }
  | { op: "set_scrim"; layer_id: string; scrim: Partial<Pick<GraphicsScrimLayer, "edge" | "height" | "color" | "strength">> }
  | { op: "set_slot_text"; slot: GraphicsSlot; text: string }
  | { op: "apply_template"; template: GraphicsDocument };

export type GraphicsEditErrorCode =
  | "invalid"
  | "unknown_layer"
  | "unknown_item"
  | "unknown_slot"
  | "wrong_kind"
  | "layer_limit"
  | "item_limit"
  | "last_item"
  | "bad_index";

export type GraphicsEditError = {
  code: GraphicsEditErrorCode;
  message: string;
  index: number | null;
  op: string | null;
};

export type GraphicsEditResult =
  | { ok: true; document: GraphicsDocument }
  | { ok: false; error: GraphicsEditError };

class EditFailure extends Error {
  readonly code: GraphicsEditErrorCode;

  constructor(code: GraphicsEditErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

type LayerOf<K extends GraphicsLayer["kind"]> = Extract<GraphicsLayer, { kind: K }>;
type PlacedLayer = Exclude<GraphicsLayer, GraphicsScrimLayer>;

const KIND_NAMES: Record<GraphicsLayer["kind"], string> = {
  text: "a text layer",
  image: "an image layer",
  qr: "a QR layer",
  scrim: "a scrim layer",
};

function insertAt<T>(list: readonly T[], index: number, value: T): T[] {
  return [...list.slice(0, index), value, ...list.slice(index)];
}

function moveTo<T>(list: readonly T[], from: number, to: number): T[] {
  const rest = list.filter((_, index) => index !== from);
  return insertAt(rest, to, list[from]);
}

function checkIndex(index: number, max: number, label: string): void {
  if (!Number.isInteger(index) || index < 0 || index > max) {
    throw new EditFailure("bad_index", `${label} must be a whole number from 0 to ${max}.`);
  }
}

function layerIndex(document: GraphicsDocument, layerId: string): number {
  const index = document.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) throw new EditFailure("unknown_layer", `Layer ${layerId} is not in these graphics.`);
  return index;
}

function requireLayer(document: GraphicsDocument, layerId: string): GraphicsLayer {
  return document.layers[layerIndex(document, layerId)];
}

function requireKind<K extends GraphicsLayer["kind"]>(document: GraphicsDocument, layerId: string, kind: K): LayerOf<K> {
  const layer = requireLayer(document, layerId);
  if (layer.kind !== kind) throw new EditFailure("wrong_kind", `Layer ${layerId} is ${KIND_NAMES[layer.kind]}, not ${KIND_NAMES[kind]}.`);
  return layer as LayerOf<K>;
}

function requirePlaced(document: GraphicsDocument, layerId: string): PlacedLayer {
  const layer = requireLayer(document, layerId);
  if (layer.kind === "scrim") throw new EditFailure("wrong_kind", `Layer ${layerId} is a scrim, which spans the frame width and has no position.`);
  return layer;
}

function requireItem(layer: GraphicsTextLayer, itemId: string): number {
  const index = layer.items.findIndex((item) => item.id === itemId);
  if (index < 0) throw new EditFailure("unknown_item", `Item ${itemId} is not in layer ${layer.id}.`);
  return index;
}

function replaceLayer(document: GraphicsDocument, layer: GraphicsLayer): GraphicsDocument {
  return { ...document, layers: document.layers.map((candidate) => (candidate.id === layer.id ? layer : candidate)) };
}

function checkLayerRoom(document: GraphicsDocument): void {
  if (document.layers.length >= MAX_GRAPHICS_LAYERS) {
    throw new EditFailure("layer_limit", `A document holds at most ${MAX_GRAPHICS_LAYERS} layers.`);
  }
}

function addLayer(document: GraphicsDocument, input: GraphicsLayerInput, index: number | undefined): GraphicsDocument {
  if (!GRAPHICS_LAYER_KINDS.includes(input.kind)) {
    throw new EditFailure("invalid", `Layer kind must be one of ${GRAPHICS_LAYER_KINDS.join(", ")}.`);
  }
  checkLayerRoom(document);
  const at = index ?? document.layers.length;
  checkIndex(at, document.layers.length, "Layer index");
  const { layer, nextId } = createGraphicsLayer(input, document.nextId);
  return { ...document, layers: insertAt(document.layers, at, layer), nextId };
}

function removeLayer(document: GraphicsDocument, layerId: string): GraphicsDocument {
  layerIndex(document, layerId);
  return { ...document, layers: document.layers.filter((layer) => layer.id !== layerId) };
}

function copyName(name: string): string {
  return (name ? `${name} copy` : "Copy").slice(0, MAX_GRAPHICS_NAME_LENGTH);
}

function duplicateLayer(document: GraphicsDocument, layerId: string): GraphicsDocument {
  const index = layerIndex(document, layerId);
  checkLayerRoom(document);
  const original = document.layers[index];
  const { layer, nextId } = createGraphicsLayer(original, document.nextId);
  const copy = { ...layer, name: copyName(original.name) };
  return { ...document, layers: insertAt(document.layers, index + 1, copy), nextId };
}

function moveLayer(document: GraphicsDocument, layerId: string, index: number): GraphicsDocument {
  const from = layerIndex(document, layerId);
  checkIndex(index, document.layers.length - 1, "Layer index");
  return { ...document, layers: moveTo(document.layers, from, index) };
}

function setLayer(document: GraphicsDocument, layerId: string, patch: Partial<Pick<GraphicsLayer, "name" | "visible" | "opacity">>): GraphicsDocument {
  const layer = requireLayer(document, layerId);
  const changes = definedFields({ name: patch.name, visible: patch.visible, opacity: patch.opacity });
  return replaceLayer(document, { ...layer, ...changes });
}

function setPosition(document: GraphicsDocument, layerId: string, patch: Partial<GraphicsPosition>): GraphicsDocument {
  const layer = requirePlaced(document, layerId);
  const changes = definedFields({ anchor: patch.anchor, x: patch.x, y: patch.y, space: patch.space });
  return replaceLayer(document, { ...layer, position: { ...layer.position, ...changes } });
}

function setTiming(document: GraphicsDocument, layerId: string, patch: Partial<GraphicsTiming>): GraphicsDocument {
  const layer = requireLayer(document, layerId);
  const changes = definedFields({ start: patch.start, end: patch.end, tail: patch.tail, fade: patch.fade });
  return replaceLayer(document, { ...layer, timing: { ...layer.timing, ...changes } });
}

function patchedPlate(current: GraphicsPlate | null, patch: PlatePatch | undefined): GraphicsPlate | null {
  if (patch === undefined) return current;
  if (patch === null) return null;
  return { ...(current ?? DEFAULT_GRAPHICS_PLATE), ...definedFields(patch) };
}

function setTextBlock(
  document: GraphicsDocument,
  layerId: string,
  patch: Partial<Pick<GraphicsTextLayer, "width" | "align" | "gap">> & { plate?: PlatePatch },
): GraphicsDocument {
  const layer = requireKind(document, layerId, "text");
  const changes = definedFields({ width: patch.width, align: patch.align, gap: patch.gap });
  return replaceLayer(document, { ...layer, ...changes, plate: patchedPlate(layer.plate, patch.plate) });
}

function addItem(document: GraphicsDocument, layerId: string, input: GraphicsTextItemInput, index: number | undefined): GraphicsDocument {
  const layer = requireKind(document, layerId, "text");
  if (layer.items.length >= MAX_GRAPHICS_ITEMS) {
    throw new EditFailure("item_limit", `A text layer holds at most ${MAX_GRAPHICS_ITEMS} items.`);
  }
  const at = index ?? layer.items.length;
  checkIndex(at, layer.items.length, "Item index");
  const { id, nextId } = nextGraphicsId(document.nextId, "t");
  const items = insertAt(layer.items, at, textItemFrom(input, id));
  return { ...replaceLayer(document, { ...layer, items }), nextId };
}

function removeItem(document: GraphicsDocument, layerId: string, itemId: string): GraphicsDocument {
  const layer = requireKind(document, layerId, "text");
  requireItem(layer, itemId);
  if (layer.items.length === 1) {
    throw new EditFailure("last_item", `Item ${itemId} is the last one in layer ${layerId}; remove the layer instead.`);
  }
  return replaceLayer(document, { ...layer, items: layer.items.filter((item) => item.id !== itemId) });
}

function moveItem(document: GraphicsDocument, layerId: string, itemId: string, index: number): GraphicsDocument {
  const layer = requireKind(document, layerId, "text");
  const from = requireItem(layer, itemId);
  checkIndex(index, layer.items.length - 1, "Item index");
  return replaceLayer(document, { ...layer, items: moveTo(layer.items, from, index) });
}

function patchedItem(item: GraphicsTextItem, patch: GraphicsTextItemInput): GraphicsTextItem {
  const text = patch.text === undefined ? item.text : normalizeGraphicsText(patch.text);
  return { ...item, ...definedFields(patch), id: item.id, text };
}

function setItem(document: GraphicsDocument, layerId: string, itemId: string, patch: GraphicsTextItemInput): GraphicsDocument {
  const layer = requireKind(document, layerId, "text");
  const index = requireItem(layer, itemId);
  const items = layer.items.map((item, at) => (at === index ? patchedItem(item, patch) : item));
  return replaceLayer(document, { ...layer, items });
}

function setImage(document: GraphicsDocument, layerId: string, patch: Partial<Pick<GraphicsImageLayer, "artifactId" | "size">>): GraphicsDocument {
  const layer = requireKind(document, layerId, "image");
  return replaceLayer(document, { ...layer, ...definedFields({ artifactId: patch.artifactId, size: patch.size }) });
}

function setQr(
  document: GraphicsDocument,
  layerId: string,
  patch: Partial<Pick<GraphicsQrLayer, "url" | "slot" | "size" | "style" | "dark" | "light" | "level">>,
): GraphicsDocument {
  const layer = requireKind(document, layerId, "qr");
  const changes = definedFields({
    url: typeof patch.url === "string" ? patch.url.trim() : patch.url,
    slot: patch.slot,
    size: patch.size,
    style: patch.style,
    dark: patch.dark,
    light: patch.light,
    level: patch.level,
  });
  return replaceLayer(document, { ...layer, ...changes });
}

function setScrim(
  document: GraphicsDocument,
  layerId: string,
  patch: Partial<Pick<GraphicsScrimLayer, "edge" | "height" | "color" | "strength">>,
): GraphicsDocument {
  const layer = requireKind(document, layerId, "scrim");
  const changes = definedFields({ edge: patch.edge, height: patch.height, color: patch.color, strength: patch.strength });
  return replaceLayer(document, { ...layer, ...changes });
}

function setSlotText(document: GraphicsDocument, slot: GraphicsSlot, text: string): GraphicsDocument {
  if (graphicsSlotValues(document)[slot] === undefined) {
    throw new EditFailure("unknown_slot", `No layer holds the ${slot} slot.`);
  }
  const value = slot === "profile" && typeof text === "string" ? text.trim() : normalizeGraphicsText(text);
  return writeGraphicsSlot(document, slot, value);
}

function applyTemplate(document: GraphicsDocument, template: GraphicsDocument): GraphicsDocument {
  const parsed = parseGraphicsDocument(template);
  if (!parsed.ok) throw new EditFailure("invalid", `Template: ${parsed.error}`);
  const replaced = appendGraphicsLayers({ ...document, layers: [] }, parsed.document.layers);
  return fillGraphicsSlots(replaced, graphicsSlotValues(document), { overwrite: true });
}

function applyGraphicsEdit(document: GraphicsDocument, edit: GraphicsEdit): GraphicsDocument {
  switch (edit.op) {
    case "add_layer": return addLayer(document, edit.layer, edit.index);
    case "remove_layer": return removeLayer(document, edit.layer_id);
    case "duplicate_layer": return duplicateLayer(document, edit.layer_id);
    case "move_layer": return moveLayer(document, edit.layer_id, edit.index);
    case "set_layer": return setLayer(document, edit.layer_id, edit.layer);
    case "set_position": return setPosition(document, edit.layer_id, edit.position);
    case "set_timing": return setTiming(document, edit.layer_id, edit.timing);
    case "set_text_block": return setTextBlock(document, edit.layer_id, edit.block);
    case "add_item": return addItem(document, edit.layer_id, edit.item ?? {}, edit.index);
    case "remove_item": return removeItem(document, edit.layer_id, edit.item_id);
    case "move_item": return moveItem(document, edit.layer_id, edit.item_id, edit.index);
    case "set_item": return setItem(document, edit.layer_id, edit.item_id, edit.item);
    case "set_image": return setImage(document, edit.layer_id, edit.image);
    case "set_qr": return setQr(document, edit.layer_id, edit.qr);
    case "set_scrim": return setScrim(document, edit.layer_id, edit.scrim);
    case "set_slot_text": return setSlotText(document, edit.slot, edit.text);
    case "apply_template": return applyTemplate(document, edit.template);
    default: throw new EditFailure("invalid", `Unknown edit operation ${String((edit as { op: unknown }).op)}.`);
  }
}

function failure(code: GraphicsEditErrorCode, message: string, index: number | null, op: string | null): GraphicsEditResult {
  return { ok: false, error: { code, message, index, op } };
}

function applyAt(document: GraphicsDocument, edit: GraphicsEdit, index: number): GraphicsEditResult {
  const op = typeof edit?.op === "string" ? edit.op : null;
  let next: GraphicsDocument;
  try {
    next = applyGraphicsEdit(document, edit);
  } catch (error) {
    if (error instanceof EditFailure) return failure(error.code, error.message, index, op);
    throw error;
  }
  const parsed = parseGraphicsDocument(next);
  return parsed.ok ? parsed : failure("invalid", parsed.error, index, op);
}

export function applyGraphicsEdits(document: GraphicsDocument, edits: readonly GraphicsEdit[]): GraphicsEditResult {
  const start = parseGraphicsDocument(document);
  if (!start.ok) return failure("invalid", start.error, null, null);
  let current: GraphicsEditResult = start;
  for (const [index, edit] of edits.entries()) {
    current = applyAt(current.document, edit, index);
    if (!current.ok) return current;
  }
  return current;
}
