/**
 * translate_payload MCP tool — dry-run translation of gen tool args into the
 * exact @apicity provider request body, for the notebook payload preview.
 * Asset slugs stand in for the upload URLs the job handlers resolve at run
 * time.
 */
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { translateToolPayload } from "../payload-builders.js";

export function translatePayloadDef(): ToolDef {
  return {
    name: "translate_payload",
    description:
      "Translate gen tool args to the @apicity provider payload. Returns the exact request body that would be sent, with asset slugs in place of upload URLs.",
    schema: {
      tool_name: z.string().describe("MCP tool name (e.g. 'generate_nano_banana_pro_google')"),
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

      const provider = typeof args._provider === "string" ? args._provider : undefined;
      try {
        const result = translateToolPayload(tool_name, args, provider);
        if (!result) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Unknown tool: ${tool_name}` }],
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Unable to translate payload: ${message}` }],
        };
      }
    },
  };
}
