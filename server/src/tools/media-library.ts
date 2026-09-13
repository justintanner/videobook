import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { BookManager } from "../book-manager.js";
import {
  searchLibraryAssets,
  setNotebookMediaSlot,
} from "../media-library.js";
import { queue } from "../queue.js";
import { searchReferenceStore } from "../search-reference-store.js";
import type { AssetTagFilter } from "../asset-tags.js";
import { isLibraryBrowseStatus } from "../library-browse.js";
import { tagSelectorSchema } from "./asset-tags.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const mediaKinds = ["audio", "image", "video"] as const;

function json(value: unknown): ToolResult {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(value),
    }],
  };
}

function failure(cause: unknown): ToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text: cause instanceof Error ? cause.message : String(cause),
    }],
  };
}

export function mediaLibraryDefs(books: BookManager): ToolDef[] {
  return [
    {
      name: "repair_library_search_indexes",
      description: "Index ready visual media that is missing Similar-search coverage across books",
      scope: "global",
      schema: { kinds: z.array(z.enum(["image", "video"])).min(1).optional() },
      handler: async (args) => {
        await books.ready();
        const kinds = [...new Set((args.kinds as string[] | undefined) ?? ["image", "video"])].sort();
        const summaries = books.list();
        const jobs = await Promise.all(summaries.map(async (book) => {
          const job = await queue.enqueue(`repair-search:${book.bookId}:${kinds.join(",")}`, {
            type: "repair_search_indexes", bookId: book.bookId, kinds,
          });
          return { bookId: book.bookId, jobId: job.id };
        }));
        return json({ jobs });
      },
    },
    {
      name: "prepare_search_reference",
      description: "Prepare an existing image or video asset for temporary reverse search",
      scope: "global",
      schema: {
        source_book_id: z.string().uuid(),
        source_artifact_id: z.string().uuid(),
        kind: z.enum(["image", "video"]),
        source_start_seconds: z.number().nonnegative().optional(),
        source_duration_seconds: z.number().positive().optional(),
      },
      handler: async (args) => {
        try {
          await books.ready();
          const sourceBookId = String(args.source_book_id);
          const source = books.get(sourceBookId);
          if (!source.ok) throw new Error(source.error.message);
          const artifact = source.value.engine.artifacts.get(
            String(args.source_artifact_id),
          );
          if (!artifact.ok) throw new Error(artifact.error.message);
          const result = await queue.enqueueAndWait(
            `prepare-search-reference-${uuidv7()}`,
            {
              type: "prepare_search_reference",
              bookId: sourceBookId,
              mediaKind: String(args.kind),
              name: artifact.value.label ?? artifact.value.artifactId,
              assetId: artifact.value.artifactId,
              ...(typeof args.source_start_seconds === "number"
                ? { sourceStartMs: args.source_start_seconds * 1_000 }
                : {}),
              ...(typeof args.source_duration_seconds === "number"
                ? { sourceDurationMs: args.source_duration_seconds * 1_000 }
                : {}),
            },
            15 * 60_000,
          );
          return json(result);
        } catch (cause) {
          return failure(cause);
        }
      },
    },
    {
      name: "release_search_reference",
      description: "Release a temporary reverse-search reference",
      scope: "global",
      schema: {
        reference_id: z.string().uuid(),
      },
      handler: async (args) => json({
        released: searchReferenceStore.release(String(args.reference_id)),
      }),
    },
    {
      name: "set_notebook_media_slot",
      description: "Attach or clear a passive notebook media slot",
      scope: "global",
      schema: {
        book_id: z.string().uuid(),
        notebook_id: z.string().uuid(),
        cell_id: z.string().uuid(),
        artifact_ref: z.string().min(1).nullable(),
        expected_revision: z.string().min(1).optional(),
      },
      handler: async (args) => {
        try {
          await books.ready();
          const book = books.get(String(args.book_id));
          if (!book.ok) throw new Error(book.error.message);
          const result = await setNotebookMediaSlot(book.value.engine, {
            notebookId: String(args.notebook_id),
            cellId: String(args.cell_id),
            artifactRef: typeof args.artifact_ref === "string"
              ? args.artifact_ref
              : null,
            ...(typeof args.expected_revision === "string"
              ? { expectedRevision: args.expected_revision }
              : {}),
          });
          return json({
            cell_id: result.cellId,
            output_artifact_id: result.outputArtifactId,
            revision: result.revision,
          });
        } catch (cause) {
          return failure(cause);
        }
      },
    },
    {
      name: "search_library_assets",
      description: "Search ready audio, image, and video assets across all books",
      scope: "global",
      schema: {
        query: z.string().optional(),
        reference_id: z.string().uuid().optional(),
        reference_range: z.object({
          start_seconds: z.number().nonnegative(),
          duration_seconds: z.number().positive().optional(),
        }).optional(),
        kinds: z.array(z.enum(mediaKinds)).min(1),
        tags_all: z.array(tagSelectorSchema).optional()
          .describe("Only assets carrying every one of these tags"),
        tags_any: z.array(tagSelectorSchema).optional()
          .describe("Only assets carrying at least one of these tags"),
        browse_status: z.enum(["ready", "processing", "error", "all"]).optional()
          .describe(
            "Browse ready, processing, error, or all media when there is no text or reverse-search query. Semantic and reverse search stay ready-only.",
          ),
        limit: z.number().int().positive().max(100).optional(),
        offset: z.number().int().nonnegative().optional(),
      },
      handler: async (args) => {
        try {
          const referenceRange = searchReferenceRange(args.reference_range);
          const tags: AssetTagFilter = {
            ...(args.tags_all ? { all: args.tags_all as AssetTagFilter["all"] } : {}),
            ...(args.tags_any ? { any: args.tags_any as AssetTagFilter["any"] } : {}),
          };
          const browseStatus = isLibraryBrowseStatus(args.browse_status)
            ? args.browse_status
            : undefined;
          return json(await searchLibraryAssets(books, {
            ...(typeof args.query === "string" ? { query: args.query } : {}),
            ...(typeof args.reference_id === "string"
              ? { referenceId: args.reference_id }
              : {}),
            ...(referenceRange ? { referenceRange } : {}),
            kinds: args.kinds as Array<typeof mediaKinds[number]>,
            tags,
            ...(browseStatus ? { browseStatus } : {}),
            ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
            ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
          }));
        } catch (cause) {
          return failure(cause);
        }
      },
    },
    {
      name: "attach_library_asset",
      description: "Copy a foreign Library asset into a book and attach it to a media slot",
      scope: "global",
      schema: {
        source_book_id: z.string().uuid(),
        source_artifact_id: z.string().uuid(),
        target_book_id: z.string().uuid(),
        notebook_id: z.string().uuid(),
        cell_id: z.string().uuid(),
        expected_output_artifact_id: z.string().uuid().nullable(),
        new_name: z.string().min(1).optional(),
      },
      handler: async (args) => {
        try {
          const jobId = `copy-library-asset-${uuidv7()}`;
          const result = await queue.enqueueAndWait<{
            sourceBookId: string;
            sourceArtifactId: string;
            targetBookId: string;
            targetArtifactId: string;
            notebookId: string;
            cellId: string;
            revision: string;
          }>(
            jobId,
            {
              type: "copy_library_asset",
              bookId: String(args.target_book_id),
              sourceBookId: String(args.source_book_id),
              sourceArtifactId: String(args.source_artifact_id),
              targetBookId: String(args.target_book_id),
              notebookId: String(args.notebook_id),
              cellId: String(args.cell_id),
              expectedOutputArtifactId:
                typeof args.expected_output_artifact_id === "string"
                  ? args.expected_output_artifact_id
                  : null,
              ...(typeof args.new_name === "string"
                ? { newName: args.new_name }
                : {}),
            },
            15 * 60_000,
          );
          return json({
            source_book_id: result.sourceBookId,
            source_artifact_id: result.sourceArtifactId,
            target_book_id: result.targetBookId,
            target_artifact_id: result.targetArtifactId,
            notebook_id: result.notebookId,
            cell_id: result.cellId,
            revision: result.revision,
          });
        } catch (cause) {
          return failure(cause);
        }
      },
    },
  ];
}

function searchReferenceRange(value: unknown): {
  startMs: number;
  durationMs?: number;
} | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const range = value as Record<string, unknown>;
  if (typeof range.start_seconds !== "number") return undefined;
  return {
    startMs: range.start_seconds * 1_000,
    ...(typeof range.duration_seconds === "number"
      ? { durationMs: range.duration_seconds * 1_000 }
      : {}),
  };
}
