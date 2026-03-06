import type { ZodRawShape } from "zod";

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
};

export type { ToolDef, ToolResult, ToolHandler };
