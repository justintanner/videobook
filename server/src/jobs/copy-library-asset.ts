import type { BookManager } from "../book-manager.js";
import {
  copyAndAttachLibraryAsset,
  copyLibraryAsset,
} from "../media-library.js";
import { registerJobHandler } from "../queue.js";

function requiredString(
  payload: Record<string, unknown>,
  key: string,
): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`copy_library_asset requires ${key}`);
  }
  return value;
}

export function registerCopyLibraryAssetJob(books: BookManager): void {
  registerJobHandler("copy_library_asset", async (payload) => {
    const input = {
      sourceBookId: requiredString(payload, "sourceBookId"),
      sourceArtifactId: requiredString(payload, "sourceArtifactId"),
      targetBookId: requiredString(payload, "targetBookId"),
      ...(typeof payload.newName === "string"
        ? { newName: payload.newName }
        : {}),
    };
    if (
      typeof payload.notebookId !== "string"
      || typeof payload.cellId !== "string"
    ) {
      return await copyLibraryAsset(books, input);
    }
    return await copyAndAttachLibraryAsset(books, {
      ...input,
      notebookId: payload.notebookId,
      cellId: payload.cellId,
      expectedOutputArtifactId:
        typeof payload.expectedOutputArtifactId === "string"
          ? payload.expectedOutputArtifactId
          : null,
    });
  });
}
