import type { ZodType } from "zod";

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
}

type ToJsonSchema = { toJSONSchema?: (options: Record<string, unknown>) => unknown };

export function toJsonSchema(schema: ZodType): JsonSchema {
  const convert = (schema as unknown as ToJsonSchema).toJSONSchema;
  if (!convert) return {};
  return convert.call(schema, { unrepresentable: "any", io: "input" }) as JsonSchema;
}

function branches(schema: JsonSchema): JsonSchema[] {
  return schema.anyOf ?? schema.oneOf ?? [schema];
}

export function schemaTypes(schema: JsonSchema): string[] {
  return branches(schema).flatMap((branch) => {
    if (Array.isArray(branch.type)) return branch.type;
    if (branch.type) return [branch.type];
    if (branch.const !== undefined) return [typeof branch.const];
    return [];
  });
}

export function propertyAt(root: JsonSchema, path: string): JsonSchema | null {
  let current: JsonSchema | undefined = root;
  for (const segment of path.split(".")) {
    if (!current) return null;
    if (/^\d+$/.test(segment)) {
      current = branches(current).find((branch) => branch.items)?.items;
      continue;
    }
    current = branches(current).find((branch) => branch.properties?.[segment])?.properties?.[segment];
  }
  return current ?? null;
}

export function isUrlObject(schema: JsonSchema | undefined): boolean {
  if (!schema) return false;
  return branches(schema).some((branch) => branch.type === "object" && branch.properties?.url !== undefined);
}

export function isArraySchema(schema: JsonSchema): boolean {
  return branches(schema).some((branch) => branch.type === "array");
}

export function arrayItems(schema: JsonSchema): JsonSchema | undefined {
  return branches(schema).find((branch) => branch.type === "array")?.items;
}

export function arrayBounds(schema: JsonSchema): { min: number; max: number | null } {
  const array = branches(schema).find((branch) => branch.type === "array");
  return { min: array?.minItems ?? 0, max: array?.maxItems ?? null };
}

export function enumValues(schema: JsonSchema): Array<string | number> {
  const values: Array<string | number> = [];
  for (const branch of branches(schema)) {
    const literals = [...(branch.enum ?? []), ...(branch.const !== undefined ? [branch.const] : [])];
    if (literals.length === 0) return [];
    for (const value of literals) {
      if (typeof value === "string" || typeof value === "number") values.push(value);
    }
  }
  return [...new Set(values)];
}

export function numberBounds(schema: JsonSchema): { minimum?: number; maximum?: number } {
  const numeric = branches(schema).find((branch) => branch.type === "number" || branch.type === "integer");
  if (!numeric) return {};
  const minimum = numeric.minimum ?? numeric.exclusiveMinimum;
  const maximum = numeric.maximum ?? numeric.exclusiveMaximum;
  return {
    ...(minimum !== undefined ? { minimum } : {}),
    ...(maximum !== undefined ? { maximum } : {}),
  };
}

export function stringMaxLength(schema: JsonSchema): number | undefined {
  return branches(schema).find((branch) => branch.type === "string")?.maxLength;
}
