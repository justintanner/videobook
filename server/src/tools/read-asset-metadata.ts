import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef, ToolResult } from "./tool-def.js";

export function readAssetMetadataDef(fs: Engine): ToolDef {
  return {
    name: "read_asset_metadata",
    description:
      "Read native artifact metadata at the current Dolt revision. " +
      "Returns the parsed value or an error if the key is missing.",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. script-desc-*)"),
      name: z.string().describe("Metadata key without dot/extension (e.g. \"original\")"),
      book_id: z.string().describe("Book id"),
    },
    handler: async (args): Promise<ToolResult> => {
      const { asset_id, name, book_id: _book_id } = args as {
        asset_id: string;
        name: string;
        book_id: string;
      };
      const result = await fs.metadata.artifacts.read<Record<string, unknown>>(asset_id, name);
      if (!result.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: result.error.message }],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
      };
    },
  };
}
