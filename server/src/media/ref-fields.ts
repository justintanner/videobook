import {
  arrayBounds,
  arrayItems,
  isArraySchema,
  isKeyframeItem,
  isUrlObject,
  nestedUrlObjectProperty,
  numberBounds,
  objectProperties,
  propertyAt,
  schemaTypes,
  type JsonSchema,
} from "./json-schema.js";
import type { FieldSlotSpec, ItemParamSpec, ModelEntry, RefRole, SlotField, SlotKind, SlotSpec } from "./types.js";

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
  loop: ["loop_url"],
  keyframe: ["keyframe_urls"],
};

function fieldPresent(input: JsonSchema, field: string): boolean {
  return propertyAt(input, field) !== null;
}

function isRequired(input: JsonSchema, field: string): boolean {
  return !field.includes(".") && (input.required ?? []).includes(field);
}

const ROLE_KIND: Readonly<Record<RefRole, SlotKind>> = {
  first_frame: "image",
  last_frame: "image",
  image: "image",
  video: "video",
  audio: "audio",
  loop: "image",
  keyframe: "image",
};

const ROLE_LABELS: Partial<Record<RefRole, string>> = {
  first_frame: "First frame",
  last_frame: "Last frame",
  loop: "Loop frame",
  keyframe: "Keyframes",
};

const GENERIC_IMAGE_LABELS = new Set(["Image", "Images", "Input", "Inputs", "Image input", "Image inputs"]);

interface ExpandedField extends SlotField {
  min: number;
}

function fieldLabel(path: string, plural: boolean): string {
  const leaf = path.split(".").filter((segment) => !/^\d+$/u.test(segment)).pop() ?? path;
  const words = leaf.replace(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase().replace(/_(urls?|list)$/u, "").split("_").filter(Boolean);
  const text = words.join(" ").replace(/\baudios\b/u, "audio");
  const counted = plural && !/s$/u.test(text) && !/audio$/u.test(text) ? `${text}s` : text;
  return counted ? counted.charAt(0).toUpperCase() + counted.slice(1) : path;
}

function urlPathFor(schema: JsonSchema | undefined): string | undefined {
  if (isKeyframeItem(schema)) return "image_url";
  if (isUrlObject(schema)) return "url";
  const nested = nestedUrlObjectProperty(schema);
  return nested ? `${nested}.url` : undefined;
}

function urlObjectItem(schema: JsonSchema | undefined): boolean {
  return isUrlObject(schema) || nestedUrlObjectProperty(schema) !== null;
}

function expandField(input: JsonSchema, field: string): ExpandedField[] {
  const schema = propertyAt(input, field)!;
  const required = isRequired(input, field);
  if (isArraySchema(schema)) {
    const bounds = arrayBounds(schema);
    const items = arrayItems(schema);
    const urlPath = urlPathFor(items);
    return [{
      path: field,
      label: fieldLabel(field, bounds.max !== 1),
      multi: true,
      max: bounds.max,
      min: required ? Math.max(1, bounds.min) : 0,
      urlObject: urlObjectItem(items),
      ...(urlPath ? { urlPath } : {}),
      ...(isKeyframeItem(items) ? { keyframe: true } : {}),
    }];
  }
  const urlPath = urlPathFor(schema);
  return [{
    path: field,
    label: fieldLabel(field, false),
    multi: false,
    max: 1,
    min: required ? 1 : 0,
    urlObject: urlObjectItem(schema),
    ...(urlPath ? { urlPath } : {}),
  }];
}

function slotLabel(role: RefRole, fields: readonly SlotField[]): string {
  const fixed = ROLE_LABELS[role];
  if (fixed) return fixed;
  const label = fields.map((field) => field.label).join(" + ");
  if (role !== "image" || !GENERIC_IMAGE_LABELS.has(label)) return label;
  return fields.some((field) => field.max !== 1) ? "Reference images" : "Reference image";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function aliasOptions(entry: ModelEntry, fieldPath: string, name: string): string[] {
  const pattern = new RegExp(`^${escapeRegExp(fieldPath)}\\.(\\d+)\\.${escapeRegExp(name)}$`, "u");
  const options: string[] = [];
  for (const [option, path] of Object.entries(entry.aliases ?? {})) {
    const position = pattern.exec(path)?.[1];
    if (position !== undefined) options[Number(position)] = option;
  }
  return options;
}

function derivedItemParam(entry: ModelEntry, role: RefRole, field: ExpandedField, name: string, schema: JsonSchema): ItemParamSpec[] {
  const types = schemaTypes(schema);
  const valueType = types.includes("integer") ? "integer" : types.includes("number") ? "number" : null;
  if (!valueType) return [];
  const fallback = entry.refItem?.[role]?.[name];
  const legacyOptions = aliasOptions(entry, field.path, name);
  return [{
    name,
    label: fieldLabel(name, false),
    valueType,
    ...numberBounds(schema),
    ...(typeof fallback === "number" ? { defaultValue: fallback } : {}),
    ...(legacyOptions.length > 0 ? { legacyOptions } : {}),
  }];
}

function itemParamsFor(input: JsonSchema, entry: ModelEntry, role: RefRole, fields: readonly ExpandedField[]): readonly ItemParamSpec[] {
  const declared = entry.itemParams?.[role];
  if (declared) return declared;
  const field = fields.find((candidate) => candidate.multi && candidate.urlPath);
  const items = field ? arrayItems(propertyAt(input, field.path)!) : undefined;
  if (!field || !items) return [];
  return Object.entries(objectProperties(items))
    .filter(([name]) => name !== field.urlPath)
    .flatMap(([name, schema]) => derivedItemParam(entry, role, field, name, schema));
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
  const fields: SlotField[] = expanded.map(({ path, label, multi, max, urlObject, urlPath, keyframe }) => ({
    path,
    label,
    multi,
    max,
    urlObject,
    ...(urlPath ? { urlPath } : {}),
    ...(keyframe ? { keyframe: true } : {}),
  }));
  const max = expanded.some((field) => field.max === null)
    ? null
    : expanded.reduce((sum, field) => sum + (field.max ?? 0), 0);
  return {
    role,
    kind: ROLE_KIND[role],
    label: slotLabel(role, fields),
    field: names.join("+"),
    fields,
    multi: max === null || max > 1,
    min: expanded.reduce((sum, field) => sum + field.min, 0),
    max,
    itemParams: itemParamsFor(input, entry, role, expanded),
  };
}

const FIELD_SLOT_FIELDS: Readonly<Record<string, { kind: SlotKind; label: string }>> = {
  mask_url: { kind: "image", label: "Mask" },
  mask_image_url: { kind: "image", label: "Mask" },
  markup_image_url: { kind: "image", label: "Markup" },
  markup: { kind: "image", label: "Markup" },
  target_audio_url: { kind: "audio", label: "Soundtrack audio" },
  middle_image_url: { kind: "image", label: "Middle frame" },
};

export function resolveFieldSlots(input: JsonSchema, claimed: ReadonlySet<string>): FieldSlotSpec[] {
  return Object.entries(FIELD_SLOT_FIELDS).flatMap(([field, spec]) => {
    if (claimed.has(field) || !fieldPresent(input, field)) return [];
    const [expanded] = expandField(input, field);
    if (!expanded) return [];
    const { min, ...slotField } = expanded;
    return [{
      target: `slot:${field}`,
      field,
      kind: spec.kind,
      label: spec.label,
      fields: [slotField],
      multi: expanded.multi,
      min,
      max: expanded.max,
    }];
  });
}

export function claimedFields(slots: readonly SlotSpec[]): Set<string> {
  const claimed = new Set<string>();
  for (const slot of slots) {
    for (const field of slot.fields) claimed.add(field.path.split(".")[0]!);
  }
  return claimed;
}
