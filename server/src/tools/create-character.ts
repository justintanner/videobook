import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function createCharacterDef(fs: VideocityFs): ToolDef {
  return {
    name: "create_character",
    description: "Create a new free-form character folder (char-*)",
    schema: {
      project_slug: z.string().describe("Project slug"),
      name: z.string().describe("Name of the character (slugified for the ID)"),
    },
    handler: async (args) => {
      const { project_slug, name } = args as { project_slug: string; name: string };
      
      const assetResult = await fs.createAsset("char", name, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create character: ${assetResult.error.message}` }],
        };
      }
      
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id: assetResult.value.assetId,
            message: `Created character folder ${assetResult.value.assetId}`,
          }),
        }],
      };
    },
  };
}
