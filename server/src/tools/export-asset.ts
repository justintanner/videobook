import type { Engine } from "videobook-engine";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { BookManager } from "../book-manager.js";
import { resolveBookReference } from "../media-library.js";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";

export function exportAssetDef(
  fs: Engine,
  books?: BookManager,
): ToolDef {
  return {
    name: "export_asset_to_project",
    description: "Export an asset from one project to a different project",
    ...(books ? { scope: "global" as const } : {}),
    schema: {
      asset_id: z.string().describe("Asset ID to export (e.g. img-cute-cat)"),
      book_id: z.string().describe("Source project slug"),
      target_project: z.string().describe("Target project slug"),
      new_name: z.string().optional().describe("Optional custom name for the exported asset"),
    },
    handler: async (args) => {
      const { asset_id, book_id, target_project, new_name } = args as {
        asset_id: string; book_id: string; target_project: string; new_name?: string;
      };
      if (book_id === target_project) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: "Source and target are the same project. Use duplicate_asset to copy within the same project.",
          }],
        };
      }

      if (books) {
        try {
          const sourceBook = await resolveBookReference(books, book_id);
          const targetBook = await resolveBookReference(books, target_project);
          if (sourceBook.bookId === targetBook.bookId) {
            throw new Error(
              "Source and target are the same project. Use duplicate_asset to copy within the same project.",
            );
          }
          const sourceArtifact = sourceBook.engine.artifacts.get(asset_id);
          if (!sourceArtifact.ok) {
            throw new Error(sourceArtifact.error.message);
          }
          const result = await queue.enqueueAndWait<{
            sourceBookId: string;
            sourceArtifactId: string;
            targetBookId: string;
            targetArtifactId: string;
            targetArtifactSlug: string;
          }>(
            `copy-library-asset-${uuidv7()}`,
            {
              type: "copy_library_asset",
              bookId: targetBook.bookId,
              sourceBookId: sourceBook.bookId,
              sourceArtifactId: sourceArtifact.value.artifactId,
              targetBookId: targetBook.bookId,
              ...(new_name ? { newName: new_name } : {}),
            },
            15 * 60_000,
          );
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                source_asset_id: asset_id,
                new_asset_id: result.targetArtifactSlug,
                source_project: book_id,
                target_project,
                source_artifact_id: result.sourceArtifactId,
                target_artifact_id: result.targetArtifactId,
                source_book_id: result.sourceBookId,
                target_book_id: result.targetBookId,
              }),
            }],
          };
        } catch (cause) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: cause instanceof Error ? cause.message : String(cause),
            }],
          };
        }
      }

      const manifestResult = await fs.files.manifest(asset_id);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const prefix = asset_id.split("-")[0];
      const originalName = asset_id.slice(prefix.length + 1);
      const name = new_name ?? originalName;

      const createResult = await fs.artifacts.create(prefix, name);
      if (!createResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: createResult.error.message }],
        };
      }

      const newAssetId = createResult.value.slug;

      for (const file of manifestResult.value.files) {
        const readResult = await fs.files.read(asset_id, file.name);
        if (!readResult.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: readResult.error.message }],
          };
        }
        const writeResult = await fs.files.write(newAssetId, file.name, readResult.value);
        if (!writeResult.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: writeResult.error.message }],
          };
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            source_asset_id: asset_id,
            new_asset_id: newAssetId,
            source_project: book_id,
            target_project,
          }),
        }],
      };
    },
  };
}
