import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";

export function registerDeleteAssetTool(server: McpServer, fs: ClipfirstFs): void {
  server.tool(
    "delete_asset",
    "Delete an asset directory",
    {
      asset_id: z.string().describe("Asset ID to delete (e.g. img-cute-cat)"),
      project_slug: z.string().describe("Project slug"),
    },
    async ({ asset_id, project_slug }) => {
      const result = await fs.deleteAsset(asset_id, project_slug);
      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: result.error.message }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "deleted",
            asset_id,
            deleted_at: result.value.deleted_at,
          }),
        }],
      };
    }
  );
}
