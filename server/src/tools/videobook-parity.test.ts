import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFs } from "videobook-engine";
import { afterEach, describe, expect, it } from "vitest";

import { getAllToolDefs } from "./index.js";

describe("Videobook MCP parity", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("preserves all 211 fork endpoints and adds notebook-native tools", async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-parity-"));
    const fs = createFs({
      projectsDir: join(root, "projects"),
      dataDir: join(root, "data"),
    });
    const names = getAllToolDefs(fs).map((definition) => definition.name);
    fs.close();

    expect(names).toHaveLength(236);
    expect(new Set(names).size).toBe(236);
    expect(names.slice(0, 211)).toHaveLength(211);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_notebooks",
      "create_notebook",
      "create_character_entity",
      "update_character",
        "get_notebook",
        "update_notebook",
        "delete_notebook",
        "run_notebook",
        "list_jobs",
        "create_prompt",
        "list_prompts",
        "create_scene",
        "list_scenes",
        "list_characters",
        "get_character",
        "storage_status",
        "storage_sync",
        "revision_history",
      ]),
    );
  });
});
