/**
 * Read array-cardinality constraints from a Zod schema.
 *
 * Covers the three patterns used in @apicity provider schemas for reference-asset
 * fields: optional/required array, tuple (fixed-length), and single string.
 *
 * The returned `max: null` means "unbounded per the Zod schema" — the UI should
 * render an add-more affordance rather than a fixed slot count.
 */

type ZodDef = {
  typeName?: string;
  innerType?: unknown;
  schema?: unknown;
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
  items?: unknown[];
};

type ZodLike = { _def?: unknown; unwrap?: () => unknown };

export type SlotConstraints = { min: number; max: number | null };

function defOf(schema: unknown): ZodDef | null {
  if (!schema || typeof schema !== "object") return null;
  const def = (schema as { _def?: unknown })._def;
  return def && typeof def === "object" ? (def as ZodDef) : null;
}

function unwrapOptional(schema: unknown): { inner: unknown; optional: boolean } {
  let cur: unknown = schema;
  let optional = false;
  let def = defOf(cur);
  while (
    def &&
    (def.typeName === "ZodOptional" ||
      def.typeName === "ZodNullable" ||
      def.typeName === "ZodEffects")
  ) {
    if (def.typeName !== "ZodEffects") optional = true;
    const next = def.typeName === "ZodEffects" ? def.schema : def.innerType;
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

  if (def.typeName === "ZodTuple") {
    const len = def.items?.length ?? 0;
    return { min: len, max: len };
  }

  if (def.typeName === "ZodArray") {
    const min = def.minLength?.value ?? 0;
    const max = def.maxLength?.value ?? null;
    return { min: optional ? 0 : min, max };
  }

  if (def.typeName === "ZodString") {
    return { min: optional ? 0 : 1, max: 1 };
  }

  return null;
}
