import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "videobook-engine";
import { CHAIN_TOOL_CATALOG } from "../chain-plan.js";
import {
  AUTO_APPLY_TOOL_NAMES,
  EDITOR_ONLY_TOOL_NAMES,
  NESTED_TIMESTAMP_PARAMS,
  READ_ONLY_TOOL_NAMES,
  TIMESTAMP_PARAMS,
} from "../chat-router.js";
import { BILLABLE_TOOL_NAMES, BILLABLE_TOOL_OPERATIONS } from "../paid-tools.js";
import { WORKFLOW_TOOLS } from "../workspace-action-catalog.js";
import { WORKSPACE_TOOL_GROUPS } from "../workspace-action-groups.js";
import { getAllToolDefs } from "./index.js";
import { VIDEO_EDITING_TOOL_CONTRACTS } from "./video-editing-command-contract.js";

describe("tool name references", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("only name registered tools", async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-tool-references-"));
    const engine = createEngine({ durableWrites: false, rootDir: root, initialBookName: "references" });
    const registered = new Set(getAllToolDefs(engine).map((definition) => definition.name));
    engine.close();

    const references: Record<string, readonly string[]> = {
      groups: Object.values(WORKSPACE_TOOL_GROUPS).flat(),
      autoApply: [...AUTO_APPLY_TOOL_NAMES],
      readOnly: [...READ_ONLY_TOOL_NAMES],
      timestamps: [...Object.keys(TIMESTAMP_PARAMS), ...Object.keys(NESTED_TIMESTAMP_PARAMS)],
      chainSteps: Object.keys(CHAIN_TOOL_CATALOG),
      billable: [...BILLABLE_TOOL_NAMES, ...Object.keys(BILLABLE_TOOL_OPERATIONS)],
      editorOnly: [...EDITOR_ONLY_TOOL_NAMES],
      contracts: VIDEO_EDITING_TOOL_CONTRACTS.map((contract) => contract.tool),
      workflows: Object.keys(WORKFLOW_TOOLS),
    };
    const unknown = Object.fromEntries(Object.entries(references)
      .map(([table, names]) => [table, names.filter((name) => !registered.has(name))])
      .filter(([, names]) => names.length > 0));

    expect(unknown).toEqual({});
  });
});
