import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";

export function registerRenameAssetTool(server: McpServer, fs: ClipfirstFs): void {
  server.tool(
    "rename_asset",
    "Rename an asset with a new name",
    {
      asset_id: z.string().describe("Asset ID to rename (e.g. img-cute-cat)"),
      new_name: z.string().describe("New name for slug generation (e.g. sunset beach)"),
      project_slug: z.string().describe("Project slug"),
    },
    async ({ asset_id, new_name, project_slug }) => {
      const result = await fs.renameAsset(asset_id, new_name, project_slug);
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
            old_asset_id: result.value.old_asset_id,
            new_asset_id: result.value.new_asset_id,
          }),
        }],
      };
    }
  );
}
