import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";

export function registerAssetManifestTool(server: McpServer, fs: ClipfirstFs): void {
  server.tool(
    "asset_manifest",
    "List all files in an asset directory",
    {
      asset_id: z.string().describe("Asset ID (e.g. img-cute-cat, vid-running-dog)"),
      project_slug: z.string().describe("Project slug"),
    },
    async ({ asset_id, project_slug }) => {
      const result = await fs.getManifest(asset_id, project_slug);
      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: result.error.message }],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
      };
    }
  );
}
