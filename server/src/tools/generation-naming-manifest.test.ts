import { scopedEngine } from "../engine.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderCommandReference,
  renderGenerationNamingManifest,
} from "../command-reference.js";
import { GENERATION_ACTIONS } from "../generation-registry.js";
import { getCanonicalCommands } from "./commands.js";
import { getAllToolDefs } from "./index.js";

const root = resolve(import.meta.dirname, "../../..");

describe("generated command documentation", () => {
  it("keeps the generation naming manifest synchronized with the registry", () => {
    const actual = readFileSync(resolve(root, "docs/generation-naming-manifest.md"), "utf8");
    expect(actual).toBe(renderGenerationNamingManifest(GENERATION_ACTIONS));
  });

  it("lists every exposed MCP endpoint and canonical slash command once", () => {
    const tools = getAllToolDefs(scopedEngine);
    const commands = getCanonicalCommands();
    const actual = readFileSync(resolve(root, "docs/command-reference.md"), "utf8");

    expect(tools).toHaveLength(291);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    expect(actual).toBe(renderCommandReference(tools, commands, GENERATION_ACTIONS));
  });
});
