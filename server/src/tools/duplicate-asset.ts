import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";

export function registerDuplicateAssetTool(server: McpServer, fs: ClipfirstFs): void {
  server.tool(
    "duplicate_asset",
    "Duplicate an asset within the same project",
    {
      asset_id: z.string().describe("Asset ID to duplicate (e.g. img-cute-cat)"),
      project_slug: z.string().describe("Project slug"),
      new_name: z.string().optional().describe("Optional custom name for the copy"),
    },
    async ({ asset_id, project_slug, new_name }) => {
      const manifestResult = await fs.getManifest(asset_id, project_slug);
      if (!manifestResult.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const prefix = asset_id.split("-")[0];
      const originalName = asset_id.slice(prefix.length + 1);
      const name = new_name ?? `${originalName} copy`;

      const createResult = await fs.createAsset(prefix, name, project_slug);
      if (!createResult.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: createResult.error.message }],
        };
      }

      const newAssetId = createResult.value.assetId;

      for (const file of manifestResult.value.files) {
        const readResult = await fs.readFile(asset_id, file.name, project_slug);
        if (!readResult.ok) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: readResult.error.message }],
          };
        }
        const writeResult = await fs.writeFile(newAssetId, file.name, readResult.value, project_slug);
        if (!writeResult.ok) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: writeResult.error.message }],
          };
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            source_asset_id: asset_id,
            new_asset_id: newAssetId,
          }),
        }],
      };
    }
  );
}
