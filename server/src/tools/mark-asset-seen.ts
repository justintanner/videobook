import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "vc-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function markAssetSeenDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "mark_asset_seen",
    description:
      "Mark an asset as seen so the sidebar's NEW badge clears. Idempotent: re-marking an already-seen asset is a no-op.",
    schema: {
      asset_id: z.string().describe("Asset ID to mark seen (e.g. img-cute-cat)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as {
        asset_id: string;
        project_slug: string;
      };
      const updated = await fs.assetWork.markSeen(project_slug, asset_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ asset_id, updated }),
          },
        ],
      };
    },
  };
}

export function registerMarkAssetSeenTool(
  server: McpServer,
  fs: ClipfirstFs,
): void {
  const def = markAssetSeenDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
