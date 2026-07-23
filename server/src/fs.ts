import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFs } from "videobook-engine";
import { contentStoreFromEnvironment } from "./content-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECTS_DIR = resolve(__dirname, "../../projects");
const DEFAULT_DATA_DIR = resolve(__dirname, "../../data");

export function environmentValue(
  value: string | undefined,
  fallback: string,
): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

export const PROJECTS_DIR = environmentValue(
  process.env.VIDEOBOOK_PROJECTS_DIR,
  DEFAULT_PROJECTS_DIR,
);
export const DATA_DIR = environmentValue(
  process.env.VIDEOBOOK_DATA_DIR,
  DEFAULT_DATA_DIR,
);
const objectStore = contentStoreFromEnvironment();
export const fs = createFs({
  projectsDir: PROJECTS_DIR,
  dataDir: DATA_DIR,
  ...(objectStore ? { objectStore } : {}),
  objectPrefix: environmentValue(
    process.env.VIDEOBOOK_OBJECT_PREFIX,
    "superlzy-media/videobook/sha256",
  ),
});

export function createFsForTest(projectsDir: string) {
  return createFs({ projectsDir, dataDir: `${projectsDir}.data` });
}
