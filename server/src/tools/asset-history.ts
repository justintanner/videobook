import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";

export function registerAssetHistoryTool(server: McpServer, fs: ClipfirstFs): void {
  server.tool(
    "asset_history",
    "Get git commit history for a specific asset",
    {
      asset_id: z.string().describe("Asset ID (e.g. img-cute-cat)"),
      project_slug: z.string().describe("Project slug"),
      limit: z.number().optional().describe("Max commits to return (default 20)"),
    },
    async ({ asset_id, project_slug, limit }) => {
      const commits = await fs.getAssetHistory(asset_id, project_slug, limit ?? 20);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(commits),
        }],
      };
    }
  );
}
