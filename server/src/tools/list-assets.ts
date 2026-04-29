import type { ClipfirstFs } from "clipfirst-engine";
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
      sort: z.enum(["newest", "oldest"]).optional().describe("Sort order by creation date"),
    },
    handler: async (args) => {
      const { project_slug, sort } = args as { project_slug: string; sort?: "newest" | "oldest" };
      const assets = await buildAssetList(fs, project_slug, sort);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ assets }) }],
      };
    },
  };
}
