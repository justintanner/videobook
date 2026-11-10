import type { GraphicsDocument, GraphicsLayer, GraphicsSlot, GraphicsTextItem } from "./model.js";
import { isGraphicsUrl, MAX_GRAPHICS_TEXT_LENGTH } from "./model.js";

export type GraphicsSlotValues = Partial<Record<GraphicsSlot, string>>;

type SlotHolder = { slot: GraphicsSlot; value: string };

function layerSlots(layer: GraphicsLayer): SlotHolder[] {
  if (layer.kind === "text") {
    return layer.items.flatMap((item) => (item.slot ? [{ slot: item.slot, value: item.text }] : []));
  }
  if (layer.kind === "qr" && layer.slot) return [{ slot: layer.slot, value: layer.url }];
  return [];
}

export function graphicsSlotValues(document: GraphicsDocument): GraphicsSlotValues {
  const values: GraphicsSlotValues = {};
  for (const holder of document.layers.flatMap(layerSlots)) {
    if (!values[holder.slot]) values[holder.slot] = holder.value;
  }
  return values;
}

function usableValue(slot: GraphicsSlot, value: string | undefined): value is string {
  if (value === undefined || value.trim() === "") return false;
  return slot === "profile" ? isGraphicsUrl(value) : value.length <= MAX_GRAPHICS_TEXT_LENGTH;
}

type SlotWrite = (slot: GraphicsSlot, current: string) => string;

function writeItem(item: GraphicsTextItem, write: SlotWrite): GraphicsTextItem {
  if (!item.slot) return item;
  const text = write(item.slot, item.text);
  return text === item.text ? item : { ...item, text };
}

function writeLayer(layer: GraphicsLayer, write: SlotWrite): GraphicsLayer {
  if (layer.kind === "text") return { ...layer, items: layer.items.map((item) => writeItem(item, write)) };
  if (layer.kind !== "qr" || !layer.slot) return layer;
  const url = write(layer.slot, layer.url);
  return url === layer.url ? layer : { ...layer, url };
}

function writeSlots(document: GraphicsDocument, write: SlotWrite): GraphicsDocument {
  return { ...document, layers: document.layers.map((layer) => writeLayer(layer, write)) };
}

export function fillGraphicsSlots(
  document: GraphicsDocument,
  values: GraphicsSlotValues,
  options: { overwrite: boolean },
): GraphicsDocument {
  return writeSlots(document, (slot, current) => {
    const value = values[slot];
    if (!usableValue(slot, value)) return current;
    return options.overwrite || current === "" ? value : current;
  });
}

export function writeGraphicsSlot(document: GraphicsDocument, slot: GraphicsSlot, value: string): GraphicsDocument {
  return writeSlots(document, (holder, current) => (holder === slot ? value : current));
}
