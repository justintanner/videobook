import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z, type ZodRawShape, type ZodType } from "zod";

type JsonSchema = Record<string, unknown>;
type JsonSchemaOverride = NonNullable<z.core.ToJSONSchemaParams["override"]>;

const ADVERTISED_SCHEMAS = new WeakMap<object, JsonSchema>();

const SUBSCHEMA_MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const SUBSCHEMA_LISTS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const SUBSCHEMAS = new Set([
  "items",
  "additionalProperties",
  "propertyNames",
  "not",
  "contains",
  "if",
  "then",
  "else",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

function isSchemaObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainStringSchema(value: unknown): boolean {
  return isSchemaObject(value)
    && Object.keys(value).length === 1
    && value.type === "string";
}

function isRedundantKeyword(key: string, value: unknown, schema: JsonSchema): boolean {
  switch (key) {
    case "$schema":
      return true;
    case "pattern":
      return typeof schema.format === "string";
    case "propertyNames":
      return isPlainStringSchema(value);
    case "maximum":
      return value === Number.MAX_SAFE_INTEGER;
    case "minimum":
      return value === Number.MIN_SAFE_INTEGER;
    default:
      return false;
  }
}

function compactSubschemaMap(value: unknown): unknown {
  if (!isSchemaObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, child]) => [name, compactNode(child)]),
  );
}

function compactKeyword(key: string, value: unknown): unknown {
  if (SUBSCHEMA_MAPS.has(key)) return compactSubschemaMap(value);
  if (SUBSCHEMA_LISTS.has(key) && Array.isArray(value)) return value.map(compactNode);
  if (!SUBSCHEMAS.has(key)) return value;
  return Array.isArray(value) ? value.map(compactNode) : compactNode(value);
}

function compactNode(value: unknown): unknown {
  if (!isSchemaObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => !isRedundantKeyword(key, child, value))
      .map(([key, child]) => [key, compactKeyword(key, child)]),
  );
}

export function advertisedAs<T extends ZodType>(schema: T, advertised: JsonSchema): T {
  ADVERTISED_SCHEMAS.set(schema, advertised);
  return schema;
}

const advertise: JsonSchemaOverride = ({ zodSchema, jsonSchema }) => {
  const advertised = ADVERTISED_SCHEMAS.get(zodSchema);
  if (!advertised) return;
  const target = jsonSchema as JsonSchema;
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, advertised);
};

export function compactJsonSchema(schema: JsonSchema): JsonSchema {
  return compactNode(schema) as JsonSchema;
}

export function toolInputJsonSchema(
  shape: ZodRawShape,
  unrepresentable: "throw" | "any" = "throw",
): JsonSchema {
  return compactJsonSchema(z.toJSONSchema(z.object(shape), {
    io: "input",
    unrepresentable,
    override: advertise,
  }) as JsonSchema);
}

export function toolInputSchema(
  shape: ZodRawShape,
): StandardSchemaWithJSON<Record<string, unknown>> {
  const standard = z.object(shape)["~standard"];
  return {
    "~standard": {
      version: standard.version,
      vendor: standard.vendor,
      validate: standard.validate,
      jsonSchema: {
        input: (options) => compactJsonSchema(standard.jsonSchema.input({
          ...options,
          libraryOptions: { ...options.libraryOptions, override: advertise },
        })),
        output: (options) => compactJsonSchema(standard.jsonSchema.output(options)),
      },
    },
  };
}
