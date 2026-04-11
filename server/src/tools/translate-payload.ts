import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { translateToolPayload, getValidationWarnings } from "../payload-builders.js";

export function translatePayloadDef(): ToolDef {
  return {
    name: "translate_payload",
    description: "Translate gen panel args to the @apicity provider payload. Returns the exact request body that would be sent, with asset slugs in place of upload URLs.",
    schema: {
      tool_name: z.string().describe("MCP tool name (e.g. 'generate_kling30_video')"),
      args_json: z.string().describe("Tool arguments as a JSON string"),
    },
    handler: async (rawArgs) => {
      const { tool_name, args_json } = rawArgs as {
        tool_name: string;
        args_json: string;
      };

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(args_json) as Record<string, unknown>;
      } catch {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Invalid JSON in args_json" }],
        };
      }

      const result = translateToolPayload(tool_name, args, args._provider as string | undefined);
      if (!result) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Unknown tool: ${tool_name}` }],
        };
      }

      const warnings = getValidationWarnings(tool_name, args);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ...result, warnings }),
        }],
      };
    },
  };
}
