import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function renameAssetDef(fs: Engine): ToolDef {
  return {
    name: "rename_asset",
    description:
      "Set an asset's display label. Labels are display-only — the artifact id and all references stay unchanged.",
    schema: {
      asset_id: z.string().describe("Artifact id of the asset to relabel"),
      new_name: z.string().describe("New display label (free text, e.g. sunset beach)"),
      book_id: z.string().describe("Book id"),
    },
    handler: async (args) => {
      const { asset_id, new_name } = args as { asset_id: string; new_name: string };
      const result = await fs.artifacts.rename({
        artifact: asset_id,
        label: new_name,
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
            artifact_id: result.value.artifactId,
            label: result.value.label ?? new_name,
          }),
        }],
      };
    },
  };
}
