import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function assetManifestDef(fs: VideocityFs): ToolDef {
  return {
    name: "asset_manifest",
    description: "List all files in an asset directory",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. img-cute-cat, vid-running-dog)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as { asset_id: string; project_slug: string };
      const result = await fs.getManifest(asset_id, project_slug);
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

export function registerAssetManifestTool(server: McpServer, fs: VideocityFs): void {
  const def = assetManifestDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
