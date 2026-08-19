import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEngine } from "videobook-engine";

const temporaryRoot = mkdtempSync(join(tmpdir(), "videobook-command-reference-"));
process.env.VIDEOBOOK_LIBRARY_DIR = join(temporaryRoot, "books");
process.env.VIDEOBOOK_APP_STATE_PATH = join(temporaryRoot, "runtime", "app-state.json");

const [
  { renderCommandReference, renderGenerationNamingManifest },
  { GENERATION_ACTIONS },
  { getCanonicalCommands },
  { getAllToolDefs },
  { bookManager },
] = await Promise.all([
  import("../server/src/command-reference.js"),
  import("../server/src/generation-registry.js"),
  import("../server/src/tools/commands.js"),
  import("../server/src/tools/index.js"),
  import("../server/src/engine.js"),
]);

const bookEngine = createEngine({
  rootDir: join(temporaryRoot, "reference-engine"),
  initialBookName: "reference",
});
const root = resolve(import.meta.dirname, "..");

try {
  writeFileSync(
    resolve(root, "docs/command-reference.md"),
    renderCommandReference(
      getAllToolDefs(bookEngine),
      getCanonicalCommands(),
      GENERATION_ACTIONS,
    ),
  );
  writeFileSync(
    resolve(root, "docs/generation-naming-manifest.md"),
    renderGenerationNamingManifest(GENERATION_ACTIONS),
  );
} finally {
  bookEngine.close();
  await bookManager.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
