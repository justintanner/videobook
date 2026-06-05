import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import type { ToolDef, ToolResult } from "./tool-def.js";

export function readAssetMetadataDef(fs: VideocityFs): ToolDef {
  return {
    name: "read_asset_metadata",
    description:
      "Read an asset's metadata sidecar at HEAD (e.g. `.original.json` → name=\"original\"). " +
      "Returns the parsed JSON or an error if the file is missing/invalid.",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. script-desc-*)"),
      name: z.string().describe("Metadata key without dot/extension (e.g. \"original\")"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args): Promise<ToolResult> => {
      const { asset_id, name, project_slug } = args as {
        asset_id: string;
        name: string;
        project_slug: string;
      };
      const result = await fs.readMetadata<Record<string, unknown>>(asset_id, name, project_slug);
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

