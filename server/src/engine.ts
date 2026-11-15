import { BookManager } from "./book-manager.js";
import { scopedBookEngine } from "./book-context.js";
import { contentStoreFromEnvironment } from "./content-store.js";
import { dataLayout } from "./data-home.js";

export function environmentValue(
  value: string | undefined,
  fallback: string,
): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function catalogBackupTemplate(): string | undefined {
  const legacy = process.env.VIDEOBOOK_CATALOG_BACKUP_URL?.trim();
  const template = process.env.VIDEOBOOK_CATALOG_BACKUP_URL_TEMPLATE?.trim();
  if (legacy && !template) {
    throw new Error(
      "VIDEOBOOK_CATALOG_BACKUP_URL is not supported for multi-book storage; use VIDEOBOOK_CATALOG_BACKUP_URL_TEMPLATE with {bookId}",
    );
  }
  if (template && !template.includes("{bookId}")) {
    throw new Error(
      "VIDEOBOOK_CATALOG_BACKUP_URL_TEMPLATE must include {bookId}",
    );
  }
  return template || undefined;
}

const BOOK_LIBRARY_DIR = environmentValue(
  process.env.VIDEOBOOK_LIBRARY_DIR,
  dataLayout().libraryDir,
);

const objectStore = contentStoreFromEnvironment();

export const bookManager = new BookManager({
  libraryDir: BOOK_LIBRARY_DIR,
  ...(objectStore ? { remoteObjects: objectStore } : {}),
  objectPrefix: environmentValue(
    process.env.VIDEOBOOK_OBJECT_PREFIX,
    "superlzy-media/videobook/sha256",
  ),
  catalogBackupName: environmentValue(
    process.env.VIDEOBOOK_CATALOG_BACKUP_NAME,
    "backup",
  ),
  ...(catalogBackupTemplate()
    ? { catalogBackupUrlTemplate: catalogBackupTemplate() }
    : {}),
});

export const scopedEngine = scopedBookEngine;

export { closeEngineForTest, createEngineForTest } from "./test-engine-catalog.js";
