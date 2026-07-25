import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { buildAssetList } from "./sync.js";

export function listAssetsDef(fs: Engine): ToolDef {
  return {
    name: "list_assets",
    description:
      "List a bounded asset page with media and thumbnail URLs.",
    schema: {
      book_id: z.string().describe("Project slug"),
      sort: z.enum(["newest", "oldest"]).optional().describe("Sort order by creation date"),
      limit: z.number().int().positive().max(500).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    handler: async (args) => {
      const { book_id, sort, limit, offset } = args as {
        book_id: string;
        sort?: "newest" | "oldest";
        limit?: number;
        offset?: number;
      };
      const allAssets = await buildAssetList(fs, book_id, sort);
      const pageOffset = offset ?? 0;
      const pageLimit = limit ?? 200;
      const assets = allAssets.slice(pageOffset, pageOffset + pageLimit);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            assets,
            page: {
              offset: pageOffset,
              limit: pageLimit,
              total: allAssets.length,
              hasMore: pageOffset + assets.length < allAssets.length,
            },
          }),
        }],
      };
    },
  };
}
