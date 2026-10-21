import { arrayBounds, arrayItems, isArraySchema, isKeyframeItem, isUrlObject, propertyAt, type JsonSchema } from "./json-schema.js";
import type { ModelEntry, RefRole, SlotField, SlotSpec } from "./types.js";

const CANDIDATES: Readonly<Record<RefRole, readonly string[]>> = {
  first_frame: [
    "first_frame_url",
    "first_frame_image_url",
    "start_image_url",
    "first_frame",
  ],
  last_frame: [
    "last_frame_url",
    "last_frame_image_url",
    "end_image_url",
    "tail_image_url",
    "last_frame",
  ],
  image: [
    "image_urls",
    "reference_image_urls",
    "image_input",
    "input_urls",
    "image_references",
    "reference_images",
    "reference_image",
    "imageUrls",
    "image_url",
    "reference_image_url",
    "image",
    "images",
  ],
  video: [
    "video_urls",
    "reference_video_urls",
    "video_list",
    "reference_video",
    "video_url",
    "first_clip_url",
    "video",
    "videos",
  ],
  audio: [
    "audio_urls",
    "reference_audio_urls",
    "audio_url",
    "driving_audio_url",
  ],
};

function fieldPresent(input: JsonSchema, field: string): boolean {
  return propertyAt(input, field) !== null;
}

function isRequired(input: JsonSchema, field: string): boolean {
  return !field.includes(".") && (input.required ?? []).includes(field);
}

interface ExpandedField extends SlotField {
  min: number;
}

function expandField(input: JsonSchema, field: string): ExpandedField[] {
  const schema = propertyAt(input, field)!;
  const required = isRequired(input, field);
  if (isArraySchema(schema)) {
    const bounds = arrayBounds(schema);
    const items = arrayItems(schema);
    return [{
      path: field,
      multi: true,
      max: bounds.max,
      min: required ? Math.max(1, bounds.min) : 0,
      urlObject: isUrlObject(items),
      ...(isKeyframeItem(items) ? { keyframe: true } : {}),
    }];
  }
  return [{ path: field, multi: false, max: 1, min: required ? 1 : 0, urlObject: isUrlObject(schema) }];
}

function overrideFields(entry: ModelEntry, role: RefRole): readonly string[] | null | undefined {
  const override = entry.refs?.[role];
  if (override === null || override === undefined) return override;
  return typeof override === "string" ? [override] : override;
}

export function resolveSlot(role: RefRole, input: JsonSchema, entry: ModelEntry): SlotSpec | null {
  const override = overrideFields(entry, role);
  if (override === null) return null;
  const names = override ?? CANDIDATES[role].filter((candidate) => fieldPresent(input, candidate)).slice(0, 1);
  if (names.length === 0) return null;
  for (const name of names) {
    if (!fieldPresent(input, name)) throw new Error(`${entry.id}: ref field ${name} for ${role} is not in the apicity schema`);
  }
  const expanded = names.flatMap((name) => expandField(input, name));
  const fields: SlotField[] = expanded.map(({ path, multi, max, urlObject, keyframe }) => ({
    path,
    multi,
    max,
    urlObject,
    ...(keyframe ? { keyframe: true } : {}),
  }));
  const max = expanded.some((field) => field.max === null)
    ? null
    : expanded.reduce((sum, field) => sum + (field.max ?? 0), 0);
  return {
    role,
    field: names.join("+"),
    fields,
    multi: max === null || max > 1,
    min: expanded.reduce((sum, field) => sum + field.min, 0),
    max,
  };
}

export function claimedFields(slots: readonly SlotSpec[]): Set<string> {
  const claimed = new Set<string>();
  for (const slot of slots) {
    for (const field of slot.fields) claimed.add(field.path.split(".")[0]!);
  }
  return claimed;
}
