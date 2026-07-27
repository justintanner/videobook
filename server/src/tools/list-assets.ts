import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { buildAssetList } from "./sync.js";

export function listAssetsDef(fs: Engine): ToolDef {
  return {
    name: "list_assets",
    description:
      "List a bounded asset page with media and thumbnail URLs, optionally including notebook-referenced assets outside the page.",
    schema: {
      book_id: z.string().describe("Project slug"),
      sort: z.enum(["newest", "oldest"]).optional().describe("Sort order by creation date"),
      limit: z.number().int().positive().max(500).optional(),
      offset: z.number().int().nonnegative().optional(),
      include_referenced: z.boolean().optional(),
    },
    handler: async (args) => {
      const { book_id, sort, limit, offset, include_referenced } = args as {
        book_id: string;
        sort?: "newest" | "oldest";
        limit?: number;
        offset?: number;
        include_referenced?: boolean;
      };
      const allAssets = await buildAssetList(fs, book_id, sort);
      const pageOffset = offset ?? 0;
      const pageLimit = limit ?? 200;
      const pageAssets = allAssets.slice(pageOffset, pageOffset + pageLimit);
      const pageArtifactIds = new Set(
        pageAssets.map((asset) => asset.artifact_id),
      );
      const referencedArtifactIds = include_referenced
        ? new Set(
            fs.notebooks
              .list()
              .flatMap((notebook) =>
                notebook.cells.flatMap((cell) => [
                  ...(cell.outputArtifactId ? [cell.outputArtifactId] : []),
                  ...(typeof cell.inputs?.firstFrameArtifactId === "string"
                    ? [cell.inputs.firstFrameArtifactId]
                    : []),
                  ...(typeof cell.inputs?.lastFrameArtifactId === "string"
                    ? [cell.inputs.lastFrameArtifactId]
                    : []),
                ])),
          )
        : new Set<string>();
      const referencedAssets = include_referenced
        ? allAssets.filter((asset) =>
            referencedArtifactIds.has(asset.artifact_id)
            && !pageArtifactIds.has(asset.artifact_id))
        : [];
      const assets = [...pageAssets, ...referencedAssets];
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            assets,
            page: {
              offset: pageOffset,
              limit: pageLimit,
              total: allAssets.length,
              hasMore: pageOffset + pageAssets.length < allAssets.length,
            },
          }),
        }],
      };
    },
  };
}
