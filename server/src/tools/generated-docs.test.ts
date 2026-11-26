import { scopedEngine } from "../engine.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCommandReference, renderGenerationModels } from "../command-reference.js";
import { getCanonicalCommands } from "./commands.js";
import { getAllToolDefs } from "./index.js";

const root = resolve(import.meta.dirname, "../../..");

describe("generated command documentation", () => {
  it("keeps the generation model list synchronized with the media catalog", () => {
    const actual = readFileSync(resolve(root, "docs/generation-models.md"), "utf8");
    expect(actual).toBe(renderGenerationModels());
  });

  it("lists every exposed MCP endpoint and canonical slash command once", () => {
    const tools = getAllToolDefs(scopedEngine);
    const commands = getCanonicalCommands();
    const actual = readFileSync(resolve(root, "docs/command-reference.md"), "utf8");

    expect(tools).toHaveLength(220);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    expect(actual).toBe(renderCommandReference(tools, commands));
  });
});
