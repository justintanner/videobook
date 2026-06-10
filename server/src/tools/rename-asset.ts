import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function renameAssetDef(fs: VideocityFs): ToolDef {
  return {
    name: "rename_asset",
    description: "Rename an asset with a new name",
    schema: {
      asset_id: z.string().describe("Asset ID to rename (e.g. img-cute-cat)"),
      new_name: z.string().describe("New name for slug generation (e.g. sunset beach)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, new_name, project_slug } = args as { asset_id: string; new_name: string; project_slug: string };
      const result = await fs.renameAsset(asset_id, new_name, project_slug);
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
            old_asset_id: result.value.old_asset_id,
            new_asset_id: result.value.new_asset_id,
          }),
        }],
      };
    },
  };
}

