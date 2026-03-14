import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { buildAssetList } from "./sync.js";

export function listAssetsDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "list_assets",
    description:
      "List all assets for a project with their media and thumbnail URLs.",
    schema: {
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };
      const assets = await buildAssetList(fs, project_slug);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ assets }) }],
      };
    },
  };
}
