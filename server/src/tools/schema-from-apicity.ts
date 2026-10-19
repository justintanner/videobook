import { z } from "zod";
import {
  readSlotConstraints,
  zodEnumOptionsOrNull,
  zodFiniteNumberOptions,
  zodIsBoolean,
  zodNumberRange,
  zodStringMaxLength,
  zodStringMinLength,
  zodUnionEnumOptions,
} from "../zod-slots.js";

type ZodLike = { _def?: unknown; unwrap?: () => unknown };

type ApicityNumberField = ReturnType<typeof z.coerce.number>;
type ApicityFieldCore =
  | z.ZodString
  | z.ZodNumber
  | ApicityNumberField
  | z.ZodBoolean
  | z.ZodEnum<Record<string, string>>;

function buildCore(schema: ZodLike): ApicityFieldCore {
  const enumOpts = zodEnumOptionsOrNull(schema);
  if (enumOpts) return z.enum(enumOpts);

  if (zodIsBoolean(schema)) return z.boolean();

  const finiteNumbers = zodFiniteNumberOptions(schema);
  if (finiteNumbers) {
    const literals = z.literal(finiteNumbers as [number, ...number[]]);
    return z.preprocess(
      (value) => typeof value === "string" && value.trim() !== "" ? Number(value) : value,
      literals,
    ) as unknown as ApicityFieldCore;
  }

  const range = zodNumberRange(schema);
  if (range) {
    let n: ApicityNumberField = z.coerce.number();
    if (range.int) n = n.int();
    if (range.min !== undefined) n = range.exclusiveMin ? n.gt(range.min) : n.min(range.min);
    if (range.max !== undefined) n = range.exclusiveMax ? n.lt(range.max) : n.max(range.max);
    return n;
  }

  let s = z.string();
  const min = zodStringMinLength(schema);
  if (min !== undefined) s = s.min(min);
  const max = zodStringMaxLength(schema);
  if (max !== undefined) s = s.max(max);
  return s;
}

export function apicityField(
  schema: ZodLike,
  describe: string | undefined,
  opts: { required: true },
): ApicityFieldCore;
export function apicityField(
  schema: ZodLike,
  describe?: string,
  opts?: { required?: false },
): z.ZodOptional<ApicityFieldCore>;
export function apicityField(
  schema: ZodLike,
  describe?: string,
  opts?: { required?: boolean },
): z.ZodOptional<ApicityFieldCore> | ApicityFieldCore {
  const core = buildCore(schema);
  const described = describe ? core.describe(describe) : core;
  return opts?.required ? described : (described.optional() as z.ZodOptional<ApicityFieldCore>);
}

export function apicityStringNumberField(
  schema: ZodLike,
  describe: string | undefined,
  opts: { required: true },
): z.ZodEnum<Record<string, string>>;
export function apicityStringNumberField(
  schema: ZodLike,
  describe?: string,
  opts?: { required?: false },
): z.ZodOptional<z.ZodEnum<Record<string, string>>>;
export function apicityStringNumberField(
  schema: ZodLike,
  describe?: string,
  opts?: { required?: boolean },
): z.ZodOptional<z.ZodEnum<Record<string, string>>> | z.ZodEnum<Record<string, string>> {
  const values = zodFiniteNumberOptions(schema);
  if (!values) throw new Error("apicityStringNumberField: schema is not a finite numeric domain");
  const core = z.enum(values.map(String) as [string, ...string[]]);
  const described = describe ? core.describe(describe) : core;
  return opts?.required ? described : described.optional();
}

export function apicityStringArrayField(
  schema: ZodLike,
  describe: string | undefined,
  opts: { required: true },
): z.ZodArray<z.ZodString>;
export function apicityStringArrayField(
  schema: ZodLike,
  describe?: string,
  opts?: { required?: false },
): z.ZodOptional<z.ZodArray<z.ZodString>>;
export function apicityStringArrayField(
  schema: ZodLike,
  describe?: string,
  opts?: { required?: boolean },
): z.ZodOptional<z.ZodArray<z.ZodString>> | z.ZodArray<z.ZodString> {
  const slots = readSlotConstraints(schema, { whenPresent: true });
  if (!slots) throw new Error("apicityStringArrayField: schema is not an array");
  let core = z.array(z.string());
  if (slots.min > 0) core = core.min(slots.min);
  if (slots.max !== null) core = core.max(slots.max);
  const described = describe ? core.describe(describe) : core;
  return opts?.required ? described : described.optional();
}

export function apicityUnionEnumField(
  schema: ZodLike,
  describe: string | undefined,
  opts: { required: true },
): z.ZodEnum<Record<string, string>>;
export function apicityUnionEnumField(
  schema: ZodLike,
  describe?: string,
  opts?: { required?: false },
): z.ZodOptional<z.ZodEnum<Record<string, string>>>;
export function apicityUnionEnumField(
  schema: ZodLike,
  describe?: string,
  opts?: { required?: boolean },
): z.ZodOptional<z.ZodEnum<Record<string, string>>> | z.ZodEnum<Record<string, string>> {
  const options = zodUnionEnumOptions(schema);
  if (!options) throw new Error("apicityUnionEnumField: schema has no enum union branch");
  const core = z.enum(options);
  const described = describe ? core.describe(describe) : core;
  return opts?.required ? described : described.optional();
}
