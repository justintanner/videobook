import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createFs } from "videobook-engine";
import {
  renderCommandReference,
  renderGenerationNamingManifest,
} from "../server/src/command-reference.js";
import { GENERATION_ACTIONS } from "../server/src/generation-registry.js";
import { getCanonicalCommands } from "../server/src/tools/commands.js";
import { getAllToolDefs } from "../server/src/tools/index.js";

const projectFs = createFs({ projectsDir: "/tmp/videocity-command-reference" });
const root = resolve(import.meta.dirname, "..");

writeFileSync(
  resolve(root, "docs/command-reference.md"),
  renderCommandReference(getAllToolDefs(projectFs), getCanonicalCommands(), GENERATION_ACTIONS),
);
writeFileSync(
  resolve(root, "docs/generation-naming-manifest.md"),
  renderGenerationNamingManifest(GENERATION_ACTIONS),
);
