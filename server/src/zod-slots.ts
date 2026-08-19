/**
 * Read array-cardinality constraints from a Zod schema.
 *
 * Covers the three patterns used in @apicity provider schemas for reference-asset
 * fields: optional/required array, tuple (fixed-length), and single string.
 *
 * Reads Zod 4 internals (`_def.type`, `_def.checks[]._zod.def`) — every
 * @apicity/* provider is unified on `zod ^4.4.3` (and the app's own zod is 4.x),
 * so the prior Zod-3 straddling readers were dropped.
 *
 * The returned `max: null` means "unbounded per the Zod schema" — the UI should
 * render an add-more affordance rather than a fixed slot count.
 */

type ZodCheckV4 = { _zod?: { def?: { check?: string; minimum?: number; maximum?: number } } };

// A single number/string `.min()/.max()/.int()` check. Zod 4 nests checks under
// `_zod.def` (`check`/`value`/`format`).
type ZodConstraintCheck = {
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
  type?: string;
  innerType?: unknown;
  schema?: unknown;
  defaultValue?: unknown;
  checks?: ZodCheckV4[];
  items?: unknown[];
  options?: unknown[];
  entries?: unknown;
  values?: unknown[];
};

type ZodLike = { _def?: unknown; unwrap?: () => unknown };

export type SlotConstraints = { min: number; max: number | null };

function defOf(schema: unknown): ZodDef | null {
  if (!schema || typeof schema !== "object") return null;
  const def = (schema as { _def?: unknown })._def;
  return def && typeof def === "object" ? (def as ZodDef) : null;
}

// Call sites keep the (unused) Zod-3 name argument so the ~30 call sites read
// `isType(x, "ZodFoo", "foo")` unchanged; only the Zod-4 `_def.type` is matched.
function isType(schema: unknown, _v3Name: string, v4Name: string): boolean {
  return defOf(schema)?.type === v4Name;
}

function readArrayBounds(def: ZodDef): { min: number; max: number | null } {
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
      isType(cur, "ZodDefault", "default") ||
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

export function readSlotConstraints(
  schema: ZodLike | null | undefined,
  options?: { whenPresent?: boolean },
): SlotConstraints | null {
  if (!schema) return null;
  const { inner, optional } = unwrapOptional(schema);
  const def = defOf(inner);
  if (!def) return null;

  if (isType(inner, "ZodTuple", "tuple")) {
    const len = def.items?.length ?? 0;
    return { min: optional && !options?.whenPresent ? 0 : len, max: len };
  }

  if (isType(inner, "ZodArray", "array")) {
    const { min, max } = readArrayBounds(def);
    return { min: optional && !options?.whenPresent ? 0 : min, max };
  }

  if (isType(inner, "ZodString", "string")) {
    return { min: optional && !options?.whenPresent ? 0 : 1, max: 1 };
  }

  return null;
}

/**
 * A non-empty list of enum string values, shaped for `z.enum(...)`.
 */
type EnumValues = [string, ...string[]];

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
 * Zod 4 stores enum values as an object map under `_def.entries`; this
 * normalizes them to a plain string tuple.
 *
 * Throws if `schema` does not resolve to an enum — these feed MCP tool input
 * schemas, so a silent empty list would be a worse failure than a loud one.
 */
export function enumOptions(schema: ZodLike | null | undefined): EnumValues {
  const def = defOf(unwrapToCore(schema));
  const values = toStringList(def?.entries);
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
// `modelInputSchemas` registry omits them). These read them out of the Zod 4
// layout (`_def.checks[]._zod.def.check`).
// ---------------------------------------------------------------------------

type NumberRange = { min?: number; max?: number; int: boolean };

function readNumberChecks(def: ZodDef): NumberRange {
  let min: number | undefined;
  let max: number | undefined;
  let int = false;
  for (const raw of (def.checks ?? []) as ZodConstraintCheck[]) {
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

export function zodFiniteNumberOptions(schema: ZodLike | null | undefined): number[] | null {
  if (!schema) return null;
  const inner = unwrapToCore(schema);
  const def = defOf(inner);
  if (!def) return null;

  const branches = isType(inner, "ZodUnion", "union")
    ? (def.options ?? [])
    : [inner];
  const values: number[] = [];

  for (const branch of branches) {
    const core = unwrapToCore(branch);
    const branchDef = defOf(core);
    if (!branchDef) return null;

    if (isType(core, "ZodLiteral", "literal")) {
      const literals = (branchDef.values ?? []).filter((value): value is number => typeof value === "number");
      if (literals.length !== (branchDef.values ?? []).length) return null;
      values.push(...literals);
      continue;
    }

    if (!isType(core, "ZodNumber", "number")) return null;
    const range = readNumberChecks(branchDef);
    if (!range.int || range.min === undefined || range.max === undefined || range.max - range.min > 1_000) {
      return null;
    }
    for (let value = range.min; value <= range.max; value++) values.push(value);
  }

  return values.length > 0 ? [...new Set(values)] : null;
}

function readStringLength(def: ZodDef, which: "min" | "max"): number | undefined {
  for (const raw of (def.checks ?? []) as ZodConstraintCheck[]) {
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

/**
 * Read the enum options from a `ZodUnion` that contains a `ZodEnum` branch
 * (e.g. fal `image_size`: an enum of named sizes unioned with a custom
 * width/height object). Returns the first enum branch's options, or null if the
 * schema is not such a union.
 */
export function zodUnionEnumOptions(schema: ZodLike | null | undefined): EnumValues | null {
  const def = defOf(unwrapToCore(schema));
  if (!def || def.type !== "union") return null;
  for (const opt of (def.options ?? []) as ZodLike[]) {
    const opts = zodEnumOptionsOrNull(opt);
    if (opts) return opts;
  }
  return null;
}
