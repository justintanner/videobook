import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createEngine, type Engine } from "videobook-engine";

export interface Sandbox {
  dir: string;
  engine: Engine;
  cleanup: () => Promise<void>;
}

export async function createSandbox(): Promise<Sandbox> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "videobook-test-"));
  const engine = createEngine({ rootDir: dir });
  await engine.ready;

  return {
    dir,
    engine,
    cleanup: async () => {
      engine.close();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
