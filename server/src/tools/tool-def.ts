import type { infer as zInfer, ZodObject, ZodRawShape } from "zod";

type ToolResult = {
  isError?: true;
  content: Array<{ type: "text"; text: string }>;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

type ToolDef = {
  name: string;
  description: string;
  schema: ZodRawShape;
  handler: ToolHandler;
  scope?: "global" | "book";
  recordsOwnActivity?: boolean;
};

type SchemaArgs<TSchema extends ZodRawShape> = zInfer<ZodObject<TSchema>>;

export type { ToolDef, ToolResult, ToolHandler, SchemaArgs };
