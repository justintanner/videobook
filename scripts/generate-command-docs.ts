import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEngine } from "videobook-engine";

const temporaryRoot = mkdtempSync(join(tmpdir(), "videobook-command-reference-"));
process.env.VIDEOBOOK_DATA_DIR = join(temporaryRoot, "global-data");
process.env.VIDEOBOOK_WORKSPACE_DIR = join(temporaryRoot, "global-workspaces");

const [
  { renderCommandReference, renderGenerationNamingManifest },
  { GENERATION_ACTIONS },
  { getCanonicalCommands },
  { getAllToolDefs },
  { fs: defaultFs },
] = await Promise.all([
  import("../server/src/command-reference.js"),
  import("../server/src/generation-registry.js"),
  import("../server/src/tools/commands.js"),
  import("../server/src/tools/index.js"),
  import("../server/src/fs.js"),
]);

const projectFs = createEngine({
  rootDir: join(temporaryRoot, "reference-engine"),
});
const root = resolve(import.meta.dirname, "..");

try {
  writeFileSync(
    resolve(root, "docs/command-reference.md"),
    renderCommandReference(
      getAllToolDefs(projectFs),
      getCanonicalCommands(),
      GENERATION_ACTIONS,
    ),
  );
  writeFileSync(
    resolve(root, "docs/generation-naming-manifest.md"),
    renderGenerationNamingManifest(GENERATION_ACTIONS),
  );
} finally {
  projectFs.close();
  defaultFs.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
