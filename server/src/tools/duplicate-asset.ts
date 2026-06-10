import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function duplicateAssetDef(fs: VideocityFs): ToolDef {
  return {
    name: "duplicate_asset",
    description: "Duplicate an asset within the same project",
    schema: {
      asset_id: z.string().describe("Asset ID to duplicate (e.g. img-cute-cat)"),
      project_slug: z.string().describe("Project slug"),
      new_name: z.string().optional().describe("Optional custom name for the copy"),
    },
    handler: async (args) => {
      const { asset_id, project_slug, new_name } = args as { asset_id: string; project_slug: string; new_name?: string };
      const manifestResult = await fs.getManifest(asset_id, project_slug, { includeDotfiles: true });
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const prefix = asset_id.split("-")[0];
      const originalName = asset_id.slice(prefix.length + 1);
      const name = new_name ?? `${originalName} copy`;

      const createResult = await fs.createAsset(prefix, name, project_slug);
      if (!createResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: createResult.error.message }],
        };
      }

      const newAssetId = createResult.value.assetId;

      const SKIP_FILES = new Set([".kie-task.json", ".generation-error.json"]);

      for (const file of manifestResult.value.files) {
        if (SKIP_FILES.has(file.name)) continue;
        const readResult = await fs.readFile(asset_id, file.name, project_slug);
        if (!readResult.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: readResult.error.message }],
          };
        }
        const writeResult = await fs.writeFile(newAssetId, file.name, readResult.value, project_slug);
        if (!writeResult.ok) {
          return {
            isError: true as const,
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
    },
  };
}

