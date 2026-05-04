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

type ZodDef = {
  typeName?: string;
  type?: string;
  innerType?: unknown;
  schema?: unknown;
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
  checks?: ZodCheckV4[];
  items?: unknown[];
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
