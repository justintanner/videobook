/**
 * Read array-cardinality constraints from a Zod schema.
 *
 * Covers the three patterns used in @apicity provider schemas for reference-asset
 * fields: optional/required array, tuple (fixed-length), and single string.
 *
 * Supports both Zod 3 (`_def.typeName`, `_def.minLength.value`) and Zod 4
 * (`_def.type`, `_def.checks`) internals, since the @apicity workspace
 * straddles both versions.
 *
 * The returned `max: null` means "unbounded per the Zod schema" — the UI should
 * render an add-more affordance rather than a fixed slot count.
 */

type ZodCheckV4 = { _zod?: { def?: { check?: string; minimum?: number; maximum?: number } } };

// A single number/string `.min()/.max()/.int()` check. The @apicity workspace
// straddles two runtime layouts: Zod 3 exposes checks flat (`kind`/`value`),
// Zod 4 nests them under `_zod.def` (`check`/`value`/`format`).
type ZodConstraintCheck = {
  kind?: string;
  value?: number;
  inclusive?: boolean;
  _zod?: {
    def?: {
      check?: string;
      value?: number;
      inclusive?: boolean;
      minimum?: number;
      maximum?: number;
      format?: string;
    };
  };
};

type ZodDef = {
  typeName?: string;
  type?: string;
  innerType?: unknown;
  schema?: unknown;
  defaultValue?: unknown;
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
  checks?: ZodCheckV4[];
  items?: unknown[];
  options?: unknown[];
  values?: unknown;
  entries?: unknown;
};

type ZodLike = { _def?: unknown; unwrap?: () => unknown };

export type SlotConstraints = { min: number; max: number | null };

function defOf(schema: unknown): ZodDef | null {
  if (!schema || typeof schema !== "object") return null;
  const def = (schema as { _def?: unknown })._def;
  return def && typeof def === "object" ? (def as ZodDef) : null;
}

function ctorName(schema: unknown): string | null {
  if (!schema || typeof schema !== "object") return null;
  const ctor = (schema as { constructor?: { name?: string } }).constructor;
  return ctor?.name ?? null;
}

function isType(schema: unknown, v3Name: string, v4Name: string): boolean {
  const def = defOf(schema);
  if (!def) return false;
  if (def.typeName === v3Name) return true;
  if (def.type === v4Name) return true;
  return ctorName(schema) === v3Name;
}

function readArrayBounds(def: ZodDef): { min: number; max: number | null } {
  const v3Min = def.minLength?.value;
  const v3Max = def.maxLength?.value;
  if (v3Min !== undefined || v3Max !== undefined) {
    return { min: v3Min ?? 0, max: v3Max ?? null };
  }
  let min = 0;
  let max: number | null = null;
  for (const c of def.checks ?? []) {
    const cdef = c?._zod?.def;
    if (!cdef) continue;
    if (cdef.check === "min_length" && typeof cdef.minimum === "number") min = cdef.minimum;
    if (cdef.check === "max_length" && typeof cdef.maximum === "number") max = cdef.maximum;
  }
  return { min, max };
}

function unwrapOptional(schema: unknown): { inner: unknown; optional: boolean } {
  let cur: unknown = schema;
  let optional = false;
  let def = defOf(cur);
  while (
    def &&
    (isType(cur, "ZodOptional", "optional") ||
      isType(cur, "ZodNullable", "nullable") ||
      isType(cur, "ZodEffects", "effects") ||
      isType(cur, "ZodPipe", "pipe"))
  ) {
    const isEffectsLike = isType(cur, "ZodEffects", "effects") || isType(cur, "ZodPipe", "pipe");
    if (!isEffectsLike) optional = true;
    const next = isEffectsLike ? (def.schema ?? def.innerType) : def.innerType;
    if (!next) break;
    cur = next;
    def = defOf(cur);
  }
  return { inner: cur, optional };
}

export function readSlotConstraints(schema: ZodLike | null | undefined): SlotConstraints | null {
  if (!schema) return null;
  const { inner, optional } = unwrapOptional(schema);
  const def = defOf(inner);
  if (!def) return null;

  if (isType(inner, "ZodTuple", "tuple")) {
    const len = def.items?.length ?? 0;
    return { min: len, max: len };
  }

  if (isType(inner, "ZodArray", "array")) {
    const { min, max } = readArrayBounds(def);
    return { min: optional ? 0 : min, max };
  }

  if (isType(inner, "ZodString", "string")) {
    return { min: optional ? 0 : 1, max: 1 };
  }

  return null;
}

/**
 * A non-empty list of enum string values, shaped for `z.enum(...)`.
 */
export type EnumValues = [string, ...string[]];

/**
 * Strip Optional/Nullable/Default/Effects/Pipe wrappers down to the inner schema.
 *
 * Unlike `readSlotConstraints`'s unwrap, this also peels `ZodDefault` — the
 * @apicity npm packages wrap several enum fields in `.default(...)` where the
 * local build used `.optional()`.
 */
function unwrapToCore(schema: unknown): unknown {
  let cur: unknown = schema;
  let def = defOf(cur);
  while (
    def &&
    (isType(cur, "ZodOptional", "optional") ||
      isType(cur, "ZodNullable", "nullable") ||
      isType(cur, "ZodDefault", "default") ||
      isType(cur, "ZodEffects", "effects") ||
      isType(cur, "ZodPipe", "pipe"))
  ) {
    const isEffectsLike = isType(cur, "ZodEffects", "effects") || isType(cur, "ZodPipe", "pipe");
    const next = isEffectsLike ? (def.schema ?? def.innerType) : def.innerType;
    if (!next) break;
    cur = next;
    def = defOf(cur);
  }
  return cur;
}

function toStringList(raw: unknown): string[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.values(raw as Record<string, unknown>)
      : [];
  return arr.filter((v): v is string => typeof v === "string");
}

/**
 * Read the string values of a (possibly wrapped) `ZodEnum`.
 *
 * Handles both internals the @apicity workspace straddles: Zod 3 exposes the
 * values as an array (`.options` / `_def.values`), Zod 4 as an object map
 * (`_def.entries`). The published `.d.ts` files are Zod-4-shaped while the
 * runtime resolves Zod 3, so this normalizes both to a plain string tuple.
 *
 * Throws if `schema` does not resolve to an enum — these feed MCP tool input
 * schemas, so a silent empty list would be a worse failure than a loud one.
 */
export function enumOptions(schema: ZodLike | null | undefined): EnumValues {
  const inner = unwrapToCore(schema);
  const optionsHolder = inner as { options?: unknown };
  const def = defOf(inner);
  const values =
    toStringList(optionsHolder?.options).length > 0
      ? toStringList(optionsHolder.options)
      : toStringList(def?.values ?? def?.entries);
  if (values.length === 0) {
    throw new Error("enumOptions: schema did not resolve to a non-empty ZodEnum");
  }
  return values as EnumValues;
}

export function zodDefault(schema: ZodLike | null | undefined): { hasDefault: boolean; value?: unknown } {
  let cur: unknown = schema;
  let def = defOf(cur);
  while (def) {
    if (isType(cur, "ZodDefault", "default")) {
      const raw = def.defaultValue;
      return {
        hasDefault: true,
        value: typeof raw === "function" ? (raw as () => unknown)() : raw,
      };
    }
    if (
      !isType(cur, "ZodOptional", "optional") &&
      !isType(cur, "ZodNullable", "nullable") &&
      !isType(cur, "ZodEffects", "effects") &&
      !isType(cur, "ZodPipe", "pipe")
    ) {
      break;
    }
    const isEffectsLike = isType(cur, "ZodEffects", "effects") || isType(cur, "ZodPipe", "pipe");
    const next = isEffectsLike ? (def.schema ?? def.innerType) : def.innerType;
    if (!next) break;
    cur = next;
    def = defOf(cur);
  }
  return { hasDefault: false };
}

export function zodIsRequired(schema: ZodLike | null | undefined): boolean {
  let cur: unknown = schema;
  let def = defOf(cur);
  while (def) {
    if (
      isType(cur, "ZodOptional", "optional") ||
      isType(cur, "ZodNullable", "nullable") ||
      isType(cur, "ZodDefault", "default")
    ) {
      return false;
    }
    if (!isType(cur, "ZodEffects", "effects") && !isType(cur, "ZodPipe", "pipe")) {
      return true;
    }
    const next = def.schema ?? def.innerType;
    if (!next) break;
    cur = next;
    def = defOf(cur);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Numeric range / string length / enum-or-null readers
//
// Numeric `.min()/.max()/.int()` and string `.min()/.max()` constraints live
// only in the runtime Zod schema (the published `.d.ts` erase them and the JSON
// `modelInputSchemas` registry omits them). These read them out, straddling the
// two runtime layouts the @apicity workspace ships: Zod 3 (kie/...: flat
// `_def.checks[].kind`) and Zod 4 (alibaba/xai/fal vs kie differ — flat vs
// `_def.checks[]._zod.def.check`).
// ---------------------------------------------------------------------------

export type NumberRange = { min?: number; max?: number; int: boolean };

function readNumberChecks(def: ZodDef): NumberRange {
  let min: number | undefined;
  let max: number | undefined;
  let int = false;
  for (const raw of (def.checks ?? []) as ZodConstraintCheck[]) {
    // Zod 3: flat `{ kind, value }`.
    if (typeof raw.kind === "string") {
      if (raw.kind === "int") int = true;
      else if (raw.kind === "min" && typeof raw.value === "number") min = raw.value;
      else if (raw.kind === "max" && typeof raw.value === "number") max = raw.value;
      continue;
    }
    // Zod 4: `{ _zod: { def: { check, value, format } } }`.
    const cdef = raw._zod?.def;
    if (!cdef) continue;
    if (cdef.check === "number_format" && cdef.format === "safeint") int = true;
    else if (cdef.check === "greater_than" && typeof cdef.value === "number") min = cdef.value;
    else if (cdef.check === "less_than" && typeof cdef.value === "number") max = cdef.value;
  }
  return { min, max, int };
}

/**
 * Read the numeric range of a (possibly wrapped) `ZodNumber`. For a
 * `ZodUnion<[ZodNumber, ZodString]>` (grok image-to-video `duration`) the number
 * branch is read. Returns null if the schema is not a number / number-union.
 */
export function zodNumberRange(schema: ZodLike | null | undefined): NumberRange | null {
  if (!schema) return null;
  let inner = unwrapToCore(schema);
  if (isType(inner, "ZodUnion", "union")) {
    const def = defOf(inner);
    const options = (def?.options ?? []) as unknown[];
    const numberOpt = options.find((o) => isType(o, "ZodNumber", "number"));
    if (!numberOpt) return null;
    inner = numberOpt;
  }
  if (!isType(inner, "ZodNumber", "number")) return null;
  const def = defOf(inner);
  return def ? readNumberChecks(def) : null;
}

function readStringLength(def: ZodDef, which: "min" | "max"): number | undefined {
  // Zod 3 also exposes string bounds as `_def.minLength/maxLength` objects.
  if (which === "min" && def.minLength != null) return def.minLength.value;
  if (which === "max" && def.maxLength != null) return def.maxLength.value;
  for (const raw of (def.checks ?? []) as ZodConstraintCheck[]) {
    if (typeof raw.kind === "string") {
      if (which === "min" && raw.kind === "min" && typeof raw.value === "number") return raw.value;
      if (which === "max" && raw.kind === "max" && typeof raw.value === "number") return raw.value;
      continue;
    }
    const cdef = raw._zod?.def;
    if (!cdef) continue;
    if (which === "min" && cdef.check === "min_length" && typeof cdef.minimum === "number") return cdef.minimum;
    if (which === "max" && cdef.check === "max_length" && typeof cdef.maximum === "number") return cdef.maximum;
  }
  return undefined;
}

/** Max string length of a (possibly wrapped) `ZodString`, or undefined. */
export function zodStringMaxLength(schema: ZodLike | null | undefined): number | undefined {
  if (!schema) return undefined;
  const inner = unwrapToCore(schema);
  if (!isType(inner, "ZodString", "string")) return undefined;
  const def = defOf(inner);
  return def ? readStringLength(def, "max") : undefined;
}

/** Min string length of a (possibly wrapped) `ZodString`, or undefined. */
export function zodStringMinLength(schema: ZodLike | null | undefined): number | undefined {
  if (!schema) return undefined;
  const inner = unwrapToCore(schema);
  if (!isType(inner, "ZodString", "string")) return undefined;
  const def = defOf(inner);
  return def ? readStringLength(def, "min") : undefined;
}

/** True when the (possibly wrapped) schema resolves to a `ZodBoolean`. */
export function zodIsBoolean(schema: ZodLike | null | undefined): boolean {
  if (!schema) return false;
  return isType(unwrapToCore(schema), "ZodBoolean", "boolean");
}

/**
 * Like {@link enumOptions} but returns null instead of throwing when the schema
 * is not a `ZodEnum`, so callers can attempt-enum-then-fall-through to numeric /
 * string / boolean handling.
 */
export function zodEnumOptionsOrNull(schema: ZodLike | null | undefined): EnumValues | null {
  try {
    return enumOptions(schema);
  } catch {
    return null;
  }
}
