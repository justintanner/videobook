import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef, ToolResult } from "./tool-def.js";

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

export function recoverAssetDef(engine: Engine): ToolDef {
  return {
    name: "recover_asset",
    description:
      "Clear a failed asset's generation error and keep its media, returning it to ready. Use clean_failed_assets instead to delete failed generations.",
    schema: {
      asset_id: z.string().describe("Asset ID to recover (vid-*, img-*, etc., or @-prefixed)"),
      book_id: z.string().describe("Book id"),
    },
    handler: async (args) => {
      const { asset_id, book_id: _book_id } = args as { asset_id: string; book_id: string };
      const assetId = asset_id.replace(/^@/, "");

      const cleared = await engine.jobs.failures.clear(assetId);
      if (!cleared.ok) {
        return error(`Failed to clear error for ${assetId}: ${cleared.error.message}`);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id: assetId, recovered: cleared.value }),
        }],
      };
    },
  };
}
