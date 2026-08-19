import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export default async function setupDoltNativeTestStorage(): Promise<() => Promise<void>> {
  const existing = process.env.VIDEOBOOK_TEST_ROOT;
  if (existing) {
    process.env.VIDEOBOOK_LIBRARY_DIR = join(existing, "books");
    process.env.VIDEOBOOK_APP_STATE_PATH = join(existing, "runtime", "app-state.json");
    return async () => undefined;
  }
  const rootDir = await mkdtemp(join(tmpdir(), "videobook-vitest-"));
  process.env.VIDEOBOOK_TEST_ROOT = rootDir;
  process.env.VIDEOBOOK_LIBRARY_DIR = join(rootDir, "books");
  process.env.VIDEOBOOK_APP_STATE_PATH = join(rootDir, "runtime", "app-state.json");

  return async () => {
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  };
}
