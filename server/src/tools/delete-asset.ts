import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function deleteAssetDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "delete_asset",
    description: "Delete an asset directory",
    schema: {
      asset_id: z.string().describe("Asset ID to delete (e.g. img-cute-cat)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as { asset_id: string; project_slug: string };
      const result = await fs.deleteAsset(asset_id, project_slug);
      if (!result.ok) {
        return {
          isError: true as const,
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
    },
  };
}

export function registerDeleteAssetTool(server: McpServer, fs: ClipfirstFs): void {
  const def = deleteAssetDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
