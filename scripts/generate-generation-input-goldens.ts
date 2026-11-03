import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryRoot = mkdtempSync(join(tmpdir(), "videobook-generation-input-goldens-"));
process.env.VIDEOBOOK_LIBRARY_DIR = join(temporaryRoot, "books");
process.env.VIDEOBOOK_APP_STATE_PATH = join(temporaryRoot, "runtime", "app-state.json");

const { renderGenerationInputGoldens } = await import("../tests/v2/fixtures/generation-input-goldens.js");
const directory = resolve(import.meta.dirname, "../tests/v2/fixtures/generation-input-goldens");

try {
  mkdirSync(directory, { recursive: true });
  const shards = renderGenerationInputGoldens();
  for (const file of readdirSync(directory)) {
    if (file.endsWith(".json") && !shards.has(file.replace(/\.json$/u, ""))) rmSync(join(directory, file));
  }
  for (const [name, text] of shards) writeFileSync(join(directory, `${name}.json`), text);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
process.exit(0);
