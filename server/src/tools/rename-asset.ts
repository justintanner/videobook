import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function renameAssetDef(fs: Engine): ToolDef {
  return {
    name: "rename_asset",
    description: "Rename an asset with a new name",
    schema: {
      asset_id: z.string().describe("Asset ID to rename (e.g. img-cute-cat)"),
      new_name: z.string().describe("New name for slug generation (e.g. sunset beach)"),
      book_id: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, new_name } = args as { asset_id: string; new_name: string };
      const result = await fs.artifacts.rename({
        artifact: asset_id,
        name: new_name,
      });
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
            old_asset_id: asset_id,
            new_asset_id: result.value.slug,
          }),
        }],
      };
    },
  };
}
