import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { BookManager } from "../book-manager.js";
import {
  searchLibraryAssets,
  setNotebookMediaSlot,
} from "../media-library.js";
import { queue } from "../queue.js";
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
        kinds: z.array(z.enum(mediaKinds)).min(1),
        limit: z.number().int().positive().max(100).optional(),
        offset: z.number().int().nonnegative().optional(),
      },
      handler: async (args) => {
        try {
          return json(await searchLibraryAssets(books, {
            ...(typeof args.query === "string" ? { query: args.query } : {}),
            kinds: args.kinds as Array<typeof mediaKinds[number]>,
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
            targetArtifactSlug: string;
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
            target_artifact_slug: result.targetArtifactSlug,
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
