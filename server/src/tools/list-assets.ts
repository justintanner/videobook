import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { buildAssetList } from "./sync.js";

export function listAssetsDef(fs: Engine): ToolDef {
  return {
    name: "list_assets",
    description:
      "List all assets for a project with their media and thumbnail URLs.",
    schema: {
      book_id: z.string().describe("Project slug"),
      sort: z.enum(["newest", "oldest"]).optional().describe("Sort order by creation date"),
    },
    handler: async (args) => {
      const { book_id, sort } = args as { book_id: string; sort?: "newest" | "oldest" };
      const assets = await buildAssetList(fs, book_id, sort);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ assets }) }],
      };
    },
  };
}
