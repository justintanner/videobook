import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef, ToolResult } from "./tool-def.js";

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

export function recoverAssetDef(fs: VideocityFs): ToolDef {
  return {
    name: "recover_asset",
    description:
      "Recover a single asset stuck in the failed/error state by clearing its persisted generation error. " +
      "Non-destructive: the asset and its media files are kept intact — only the error record is removed, " +
      "returning the card to its normal ready state. Use this instead of clear_failed_tasks (which deletes assets).",
    schema: {
      asset_id: z.string().describe("Asset ID to recover (vid-*, img-*, etc., or @-prefixed)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as { asset_id: string; project_slug: string };
      const assetId = asset_id.replace(/^@/, "");

      const cleared = await fs.generationErrors.clear(project_slug, assetId);
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
