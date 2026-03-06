import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function assetHistoryDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "asset_history",
    description: "Get git commit history for a specific asset",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. img-cute-cat)"),
      project_slug: z.string().describe("Project slug"),
      limit: z.number().optional().describe("Max commits to return (default 20)"),
    },
    handler: async (args) => {
      const { asset_id, project_slug, limit } = args as { asset_id: string; project_slug: string; limit?: number };
      const commits = await fs.getAssetHistory(asset_id, project_slug, limit ?? 20);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(commits),
        }],
      };
    },
  };
}

export function registerAssetHistoryTool(server: McpServer, fs: ClipfirstFs): void {
  const def = assetHistoryDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
