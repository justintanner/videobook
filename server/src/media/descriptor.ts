import { MODEL_DISPLAY } from "@apicity/cost";
import { modelEntry } from "./catalog.js";
import { parseModelId } from "./model-id.js";
import { preferredDefaults } from "./preferred-defaults.js";
import { claimedFields, resolveSlot } from "./ref-fields.js";
import { wireSpec } from "./wire.js";
import {
  enumValues,
  numberBounds,
  propertyAt,
  schemaTypes,
  stringMaxLength,
  toJsonSchema,
  type JsonSchema,
} from "./json-schema.js";
import {
  REF_ROLES,
  type ModeSpec,
  type ModelEntry,
  type OptionSpec,
  type OptionValueType,
  type ResolvedModel,
  type SlotSpec,
} from "./types.js";

const PROMPT_CANDIDATES = ["prompt", "text", "instruction", "description"];

const cache = new Map<string, ResolvedModel>();

export class UnknownModelError extends Error {
  constructor(model: string) {
    super(`Unknown model ${model}; call list_generation_models for available models`);
    this.name = "UnknownModelError";
  }
}

function displayTitle(entry: ModelEntry, provider: string, apiId: string): string {
  if (entry.title) return entry.title;
  const table = MODEL_DISPLAY as unknown as Record<string, Record<string, string> | undefined>;
  return table[provider]?.[apiId] ?? apiId;
}

function resolvePromptField(entry: ModelEntry, input: JsonSchema): string | null {
  if (entry.prompt === null) return null;
  if (entry.prompt !== undefined) {
    if (!propertyAt(input, entry.prompt)) throw new Error(`${entry.id}: prompt field ${entry.prompt} is not in the apicity schema`);
    return entry.prompt;
  }
  return PROMPT_CANDIDATES.find((field) => input.properties?.[field] !== undefined) ?? null;
}

function valueType(schema: JsonSchema): OptionValueType {
  const types = new Set(schemaTypes(schema).filter((type) => type !== "null"));
  if (types.size === 0) return "json";
  if ([...types].every((type) => type === "boolean")) return "boolean";
  if ([...types].every((type) => type === "integer")) return "integer";
  if ([...types].every((type) => type === "integer" || type === "number")) return "number";
  if (types.has("string") && [...types].every((type) => type === "string" || type === "number" || type === "integer")) {
    return types.has("number") || types.has("integer") ? "json" : "string";
  }
  return "json";
}

function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function optionSpec(
  name: string,
  path: string,
  schema: JsonSchema,
  required: boolean,
  defaults: Record<string, unknown>,
): OptionSpec {
  const enumList = enumValues(schema);
  const maxLength = stringMaxLength(schema);
  const defaultValue = readPath(defaults, path) ?? schema.default;
  return {
    name,
    path,
    valueType: enumList.length > 0 && enumList.every((value) => typeof value === "string") ? "string" : valueType(schema),
    required: required && defaultValue === undefined,
    enumValues: enumList,
    ...numberBounds(schema),
    ...(maxLength !== undefined ? { maxLength } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    description: schema.description ?? "",
  };
}

function resolveOptions(
  entry: ModelEntry,
  input: JsonSchema,
  excluded: Set<string>,
  fixed: Record<string, unknown>,
): OptionSpec[] {
  const required = new Set(input.required ?? []);
  const defaults = entry.defaults ?? {};
  const options: OptionSpec[] = [];
  for (const [name, schema] of Object.entries(input.properties ?? {})) {
    if (excluded.has(name) || name in fixed) continue;
    options.push(optionSpec(name, name, schema, required.has(name), defaults));
  }
  for (const [name, path] of Object.entries(entry.aliases ?? {})) {
    const schema = propertyAt(input, path);
    if (!schema) throw new Error(`${entry.id}: alias ${name} -> ${path} is not in the apicity schema`);
    options.push(optionSpec(name, path, schema, false, defaults));
  }
  return options;
}

function defaultModes(slots: readonly SlotSpec[]): ModeSpec[] {
  return [{ id: "default", label: "Default", roles: slots.map((slot) => slot.role) }];
}

function resolveSlots(entry: ModelEntry, input: JsonSchema, promptField: string | null): SlotSpec[] {
  const slots: SlotSpec[] = [];
  const used = new Set<string>(promptField ? [promptField.split(".")[0]!] : []);
  for (const role of REF_ROLES) {
    const slot = resolveSlot(role, input, entry);
    if (!slot || slot.fields.some((field) => used.has(field.path))) continue;
    for (const field of slot.fields) used.add(field.path);
    slots.push(slot);
  }
  return slots;
}

function build(entry: ModelEntry): ResolvedModel {
  const parsed = parseModelId(entry.id);
  if (!parsed) throw new Error(`Invalid model id in catalog: ${entry.id}`);
  const wire = wireSpec(parsed);
  if (!wire) throw new Error(`${entry.id}: apicity has no request schema for this model`);
  const input = toJsonSchema(wire.input);
  const promptField = resolvePromptField(entry, input);
  const slots = resolveSlots(entry, input, promptField);
  const excluded = claimedFields(slots);
  const promptTop = promptField?.split(".")[0];
  if (promptTop && promptField === promptTop) excluded.add(promptTop);
  const aliasTops = new Set(Object.values(entry.aliases ?? {}).map((path) => path.split(".")[0]!));
  for (const top of aliasTops) excluded.add(top);
  if (promptTop) excluded.add(promptTop);
  const preferred = preferredDefaults(entry, resolveOptions(entry, input, excluded, wire.fixed));
  const tuned: ModelEntry = { ...entry, defaults: { ...entry.defaults, ...preferred } };
  return {
    entry: tuned,
    id: entry.id,
    provider: parsed.provider,
    apiId: parsed.apiId,
    media: entry.media,
    title: displayTitle(entry, parsed.provider, parsed.apiId),
    wire,
    promptField,
    promptRequired: promptTop !== undefined && promptField === promptTop && (input.required ?? []).includes(promptTop),
    slots,
    options: resolveOptions(tuned, input, excluded, wire.fixed),
    modes: entry.modes ? [...entry.modes] : defaultModes(slots),
  };
}

export function resolveModel(model: string): ResolvedModel {
  const cached = cache.get(model);
  if (cached) return cached;
  const entry = modelEntry(model);
  if (!entry) throw new UnknownModelError(model);
  const resolved = build(entry);
  cache.set(model, resolved);
  return resolved;
}

export function tryResolveModel(model: string): ResolvedModel | null {
  try {
    return resolveModel(model);
  } catch {
    return null;
  }
}
