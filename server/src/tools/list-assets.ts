import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { buildAssetList } from "./reconcile-project-work.js";
import {
  matchesTagFilter,
  type AssetTagFilter,
} from "../asset-tags.js";
import { tagSelectorSchema } from "./asset-tags.js";
import {
  LIBRARY_BROWSE_STATUSES,
  isLibraryBrowseStatus,
  pageLibraryAssets,
  type LibraryBrowseStatus,
} from "../library-browse.js";

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
      browse_status: z.enum(LIBRARY_BROWSE_STATUSES).optional()
        .describe(
          "Filter Library media by artifact status before paging. Omit to keep the unfiltered page, including notebooks and other non-media artifacts.",
        ),
      tags_all: z.array(tagSelectorSchema).optional()
        .describe("Only assets carrying every one of these tags"),
      tags_any: z.array(tagSelectorSchema).optional()
        .describe("Only assets carrying at least one of these tags"),
    },
    handler: async (args) => {
      const {
        book_id,
        sort,
        limit,
        offset,
        include_referenced,
        browse_status,
        tags_all,
        tags_any,
      } = args as {
        book_id: string;
        sort?: "newest" | "oldest";
        limit?: number;
        offset?: number;
        include_referenced?: boolean;
        browse_status?: LibraryBrowseStatus;
        tags_all?: AssetTagFilter["all"];
        tags_any?: AssetTagFilter["any"];
      };
      const allAssets = await buildAssetList(engine, book_id, sort);
      const tagFilter: AssetTagFilter = {
        ...(tags_all ? { all: tags_all } : {}),
        ...(tags_any ? { any: tags_any } : {}),
      };
      let taggedAssets: typeof allAssets;
      try {
        taggedAssets = allAssets.filter((asset) =>
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
      const browseStatus = isLibraryBrowseStatus(browse_status)
        ? browse_status
        : undefined;
      const paged = pageLibraryAssets(taggedAssets, {
        ...(browseStatus ? { browseStatus } : {}),
        offset: offset ?? 0,
        limit: limit ?? 200,
      });
      const pageArtifactIds = new Set(
        paged.pageAssets.map((asset) => asset.artifact_id),
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
      const assets = [...paged.pageAssets, ...referencedAssets];
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            assets,
            page: paged.page,
            status_counts: paged.statusCounts,
          }),
        }],
      };
    },
  };
}
