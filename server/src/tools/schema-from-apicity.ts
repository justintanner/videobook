/**
 * Build an MCP tool input field from an @apicity request-field schema, so tool
 * schemas don't re-type enums / numeric ranges / string lengths that apicity
 * already defines.
 *
 * The apicity field's constraints are read via the helpers in `zod-slots.ts`
 * and rebuilt as a fresh field in the app's own zod — the apicity schema object
 * itself is never re-exported, so no cross-instance schema mixing occurs.
 *
 * Use only for params that map 1:1 to an apicity field. Slug/URL fields and
 * bespoke params (`project_slug`, `_provider`, `image_slugs`, …) stay
 * hand-written by the caller.
 */
import { z } from "zod";
import {
  zodEnumOptionsOrNull,
  zodIsBoolean,
  zodNumberRange,
  zodStringMaxLength,
  zodStringMinLength,
} from "../zod-slots.js";

type ZodLike = { _def?: unknown; unwrap?: () => unknown };

type ApicityFieldCore = z.ZodString | z.ZodNumber | z.ZodBoolean | z.ZodEnum<Record<string, string>>;

function buildCore(schema: ZodLike): ApicityFieldCore {
  const enumOpts = zodEnumOptionsOrNull(schema);
  if (enumOpts) return z.enum(enumOpts);

  if (zodIsBoolean(schema)) return z.boolean();

  const range = zodNumberRange(schema);
  if (range) {
    let n = z.number();
    if (range.int) n = n.int();
    if (range.min !== undefined) n = n.min(range.min);
    if (range.max !== undefined) n = n.max(range.max);
    return n;
  }

  let s = z.string();
  const min = zodStringMinLength(schema);
  if (min !== undefined) s = s.min(min);
  const max = zodStringMaxLength(schema);
  if (max !== undefined) s = s.max(max);
  return s;
}

/**
 * An MCP field mirroring an apicity field's constraints (enum / numeric range /
 * string length / boolean). Optional by default; pass `required: true` to keep a
 * field that was required at the MCP layer. Runtime validation enforces the real
 * constraint regardless of inferred type width.
 */
export function apicityField(
  schema: ZodLike,
  describe?: string,
  opts?: { required?: boolean },
): z.ZodOptional<ApicityFieldCore> | ApicityFieldCore {
  const core = buildCore(schema);
  const described = describe ? core.describe(describe) : core;
  return opts?.required ? described : (described.optional() as z.ZodOptional<ApicityFieldCore>);
}
