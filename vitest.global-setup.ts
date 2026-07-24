import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export default async function setupDoltNativeTestStorage(): Promise<() => Promise<void>> {
  const rootDir = await mkdtemp(join(tmpdir(), "videobook-vitest-"));
  process.env.VIDEOBOOK_TEST_ROOT = rootDir;
  process.env.VIDEOBOOK_DATA_DIR = join(rootDir, "data");
  process.env.VIDEOBOOK_WORKSPACE_DIR = join(rootDir, "workspaces");

  return async () => {
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  };
}
