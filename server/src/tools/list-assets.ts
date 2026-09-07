import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { buildAssetList } from "./reconcile-project-work.js";
import {
  matchesTagFilter,
  type AssetTagFilter,
} from "../asset-tags.js";
import { tagSelectorSchema } from "./asset-tags.js";

export function listAssetsDef(engine: Engine): ToolDef {
  return {
    name: "list_assets",
    description:
      "List a bounded asset page with media and thumbnail URLs, optionally including notebook-referenced assets outside the page.",
    schema: {
      book_id: z.string().describe("Book id"),
      sort: z.enum(["newest", "oldest"]).optional().describe("Sort order by creation date"),
      limit: z.number().int().positive().max(500).optional(),
      offset: z.number().int().nonnegative().optional(),
      include_referenced: z.boolean().optional(),
      tags_all: z.array(tagSelectorSchema).optional()
        .describe("Only assets carrying every one of these tags"),
      tags_any: z.array(tagSelectorSchema).optional()
        .describe("Only assets carrying at least one of these tags"),
    },
    handler: async (args) => {
      const { book_id, sort, limit, offset, include_referenced, tags_all, tags_any } =
        args as {
          book_id: string;
          sort?: "newest" | "oldest";
          limit?: number;
          offset?: number;
          include_referenced?: boolean;
          tags_all?: AssetTagFilter["all"];
          tags_any?: AssetTagFilter["any"];
        };
      const allAssets = await buildAssetList(engine, book_id, sort);
      const tagFilter: AssetTagFilter = {
        ...(tags_all ? { all: tags_all } : {}),
        ...(tags_any ? { any: tags_any } : {}),
      };
      let matchingAssets: typeof allAssets;
      try {
        matchingAssets = allAssets.filter((asset) =>
          matchesTagFilter(asset.tags ?? undefined, tagFilter));
      } catch (cause) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: cause instanceof Error ? cause.message : String(cause),
          }],
        };
      }
      const pageOffset = offset ?? 0;
      const pageLimit = limit ?? 200;
      const pageAssets = matchingAssets.slice(pageOffset, pageOffset + pageLimit);
      const pageArtifactIds = new Set(
        pageAssets.map((asset) => asset.artifact_id),
      );
      const referencedArtifactIds = include_referenced
        ? new Set(
            engine.notebooks
              .list()
              .flatMap((notebook) =>
                notebook.cells.flatMap((cell) => {
                  const versionIds = Array.isArray(
                    cell.inputs?.outputVersionArtifactIds,
                  )
                    ? cell.inputs.outputVersionArtifactIds.filter(
                      (id): id is string => typeof id === "string" && id.length > 0,
                    )
                    : [];
                  return [
                    ...(cell.outputArtifactId ? [cell.outputArtifactId] : []),
                    ...(typeof cell.inputs?.firstFrameArtifactId === "string"
                      ? [cell.inputs.firstFrameArtifactId]
                      : []),
                    ...(typeof cell.inputs?.lastFrameArtifactId === "string"
                      ? [cell.inputs.lastFrameArtifactId]
                      : []),
                    ...(typeof cell.inputs?.providerArtifactId === "string"
                      ? [cell.inputs.providerArtifactId]
                      : []),
                    ...versionIds,
                  ];
                })),
          )
        : new Set<string>();
      // Hydration is deliberately unfiltered: a notebook needs the media it
      // references whether or not that asset carries the filtered tags.
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
              total: matchingAssets.length,
              hasMore: pageOffset + pageAssets.length < matchingAssets.length,
            },
          }),
        }],
      };
    },
  };
}
