import type { ClipfirstFs } from "clipfirst-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function updateScriptDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "update_script",
    description: "Update a script asset's markdown content (original.md).",
    schema: {
      asset_id: z.string().describe("Asset ID of the script"),
      content: z.string().describe("New markdown content"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, content, project_slug } = args as {
        asset_id: string;
        content: string;
        project_slug: string;
      };

      const result = await fs.writeFile(asset_id, "original.md", content, project_slug);
      if (!result.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: result.error.message }],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, path: result.value }) }],
      };
    },
  };
}
