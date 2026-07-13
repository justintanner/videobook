import { createFs } from "videocity-engine";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
(async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
  const fs = createFs({ projectsDir: tempDir });
  await fs.createProject("test-proj");
  await fs.createAsset("nb", "test notebook", "test-proj", { id: "nb-1" });
  const res = await fs.writeMetadata("nb-1", "capture_layout", {}, "test-proj");
  console.log("write", res);
  await rm(tempDir, { recursive: true, force: true });
})();
