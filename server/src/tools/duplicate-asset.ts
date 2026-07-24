import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function duplicateAssetDef(fs: Engine): ToolDef {
  return {
    name: "duplicate_asset",
    description: "Duplicate an asset within the same project",
    schema: {
      asset_id: z.string().describe("Asset ID to duplicate (e.g. img-cute-cat)"),
      book_id: z.string().describe("Project slug"),
      new_name: z.string().optional().describe("Optional custom name for the copy"),
    },
    handler: async (args) => {
      const { asset_id, book_id: _book_id, new_name } = args as { asset_id: string; book_id: string; new_name?: string };
      const manifestResult = await fs.files.manifest(asset_id);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const prefix = asset_id.split("-")[0];
      const originalName = asset_id.slice(prefix.length + 1);
      const name = new_name ?? `${originalName} copy`;

      const createResult = await fs.artifacts.create(prefix, name);
      if (!createResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: createResult.error.message }],
        };
      }

      const newAssetId = createResult.value.slug;

      for (const file of manifestResult.value.files) {
        const readResult = await fs.files.read(asset_id, file.name);
        if (!readResult.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: readResult.error.message }],
          };
        }
        const writeResult = await fs.files.write(newAssetId, file.name, readResult.value);
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
