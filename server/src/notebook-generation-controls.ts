type NotebookGenerationControlValue = string | number | boolean;

export interface NotebookGenerationControl {
  name: string;
  label: string;
  kind: "select" | "boolean" | "number" | "text";
  valueType: "string" | "number" | "boolean";
  required: boolean;
  defaultValue?: NotebookGenerationControlValue;
  options?: NotebookGenerationControlValue[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: boolean;
  exclusiveMaximum?: boolean;
  description: string;
}

type JsonSchemaProperty = {
  type?: unknown;
  description?: unknown;
  enum?: unknown;
  default?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  exclusiveMinimum?: unknown;
  exclusiveMaximum?: unknown;
};

type JsonSchemaObject = {
  properties?: unknown;
  required?: unknown;
  defaults?: unknown;
};

const connectionOwnedFields = new Set([
  "book_id",
  "project_slug",
  "prompt",
  "text",
  "character_image_refs",
  "image_refs",
  "image_ref",
  "first_frame_ref",
  "last_frame_ref",
  "end_frame_ref",
  "video_refs",
  "motion_video_refs",
  "video_ref",
  "first_clip_ref",
  "audio_refs",
  "audio_ref",
  "driving_audio_ref",
  "replace_audio_with",
  "character_refs",
  "voice_refs",
  "_provider",
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function controlValue(value: unknown): NotebookGenerationControlValue | undefined {
  return typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
    ? value
    : undefined;
}

function labelFor(name: string): string {
  if (name === "model") return "Variant";
  if (name === "output_resolution") return "Resolution";
  return name
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function controlKind(
  property: JsonSchemaProperty,
  options: NotebookGenerationControlValue[],
): Pick<NotebookGenerationControl, "kind" | "valueType"> | null {
  if (options.length > 0) {
    const valueType = options.every((value) => typeof value === "number")
      ? "number"
      : options.every((value) => typeof value === "boolean")
        ? "boolean"
        : "string";
    return { kind: "select", valueType };
  }
  if (property.type === "boolean") {
    return { kind: "boolean", valueType: "boolean" };
  }
  if (property.type === "integer" || property.type === "number") {
    return { kind: "number", valueType: "number" };
  }
  if (property.type === "string") {
    return { kind: "text", valueType: "string" };
  }
  return null;
}

export function notebookGenerationControls(
  value: unknown,
  overrides: Record<string, NotebookGenerationControlValue> = {},
): NotebookGenerationControl[] {
  const schema = record(value) as JsonSchemaObject | null;
  const properties = record(schema?.properties);
  if (!properties) return [];
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [],
  );
  const defaults = record(schema?.defaults) ?? {};
  return Object.entries(properties).flatMap(([name, rawProperty]) => {
    if (connectionOwnedFields.has(name)) return [];
    const property = record(rawProperty) as JsonSchemaProperty | null;
    if (!property) return [];
    const options = Array.isArray(property.enum)
      ? property.enum.flatMap((entry) => {
        const parsed = controlValue(entry);
        return parsed === undefined ? [] : [parsed];
      })
      : [];
    const type = controlKind(property, options);
    if (!type) return [];
    const defaultValue = controlValue(
      overrides[name] ?? defaults[name] ?? property.default,
    );
    return [{
      name,
      label: labelFor(name),
      ...type,
      required: required.has(name),
      ...(defaultValue === undefined ? {} : { defaultValue }),
      ...(options.length === 0 ? {} : { options }),
      ...(typeof property.minimum === "number"
        ? { minimum: property.minimum }
        : {}),
      ...(typeof property.maximum === "number"
        ? { maximum: property.maximum }
        : {}),
      ...(property.exclusiveMinimum === true ? { exclusiveMinimum: true } : {}),
      ...(property.exclusiveMaximum === true ? { exclusiveMaximum: true } : {}),
      description: typeof property.description === "string"
        ? property.description
        : labelFor(name),
    }];
  });
}
