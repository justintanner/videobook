import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";

export function registerExportAssetTool(server: McpServer, fs: ClipfirstFs): void {
  server.tool(
    "export_asset_to_project",
    "Export an asset from one project to a different project",
    {
      asset_id: z.string().describe("Asset ID to export (e.g. img-cute-cat)"),
      project_slug: z.string().describe("Source project slug"),
      target_project: z.string().describe("Target project slug"),
      new_name: z.string().optional().describe("Optional custom name for the exported asset"),
    },
    async ({ asset_id, project_slug, target_project, new_name }) => {
      if (project_slug === target_project) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: "Source and target are the same project. Use duplicate_asset to copy within the same project.",
          }],
        };
      }

      const manifestResult = await fs.getManifest(asset_id, project_slug);
      if (!manifestResult.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const prefix = asset_id.split("-")[0];
      const originalName = asset_id.slice(prefix.length + 1);
      const name = new_name ?? originalName;

      const createResult = await fs.createAsset(prefix, name, target_project);
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
        const writeResult = await fs.writeFile(newAssetId, file.name, readResult.value, target_project);
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
            source_project: project_slug,
            target_project,
          }),
        }],
      };
    }
  );
}
