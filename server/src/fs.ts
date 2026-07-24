import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "videobook-engine";
import { contentStoreFromEnvironment } from "./content-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE_DIR = resolve(__dirname, "../../workspaces");
const DEFAULT_DATA_DIR = resolve(__dirname, "../../data");

export function environmentValue(
  value: string | undefined,
  fallback: string,
): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

export const WORKSPACE_DIR = environmentValue(
  process.env.VIDEOBOOK_WORKSPACE_DIR,
  DEFAULT_WORKSPACE_DIR,
);
export const DATA_DIR = environmentValue(
  process.env.VIDEOBOOK_DATA_DIR,
  DEFAULT_DATA_DIR,
);
const objectStore = contentStoreFromEnvironment();
export const fs = createEngine({
  dataDir: DATA_DIR,
  workspaceDir: WORKSPACE_DIR,
  ...(objectStore ? { remoteObjects: objectStore } : {}),
  objectPrefix: environmentValue(
    process.env.VIDEOBOOK_OBJECT_PREFIX,
    "superlzy-media/videobook/sha256",
  ),
  ...(process.env.VIDEOBOOK_CATALOG_BACKUP_URL?.trim()
    ? {
        catalogBackup: {
          name: environmentValue(
            process.env.VIDEOBOOK_CATALOG_BACKUP_NAME,
            "backup",
          ),
          url: process.env.VIDEOBOOK_CATALOG_BACKUP_URL.trim(),
        },
      }
    : {}),
});

const testEngines = new Map<string, ReturnType<typeof createEngine>>();

export function createEngineForTest(rootDir: string) {
  const normalizedRoot = resolve(rootDir);
  const existing = testEngines.get(normalizedRoot);
  if (existing) return existing;
  const engine = createEngine({ rootDir: normalizedRoot });
  testEngines.set(normalizedRoot, engine);
  return engine;
}

export function closeEngineForTest(
  rootDir: string,
  engine: ReturnType<typeof createEngine>,
): void {
  const normalizedRoot = resolve(rootDir);
  if (testEngines.get(normalizedRoot) === engine) {
    testEngines.delete(normalizedRoot);
  }
  engine.close();
}
