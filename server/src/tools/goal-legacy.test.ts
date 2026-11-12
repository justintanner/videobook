import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { getChainRun } from "../chain-executor.js";
import { createEngineForTest } from "../engine.js";
import { LEGACY_GOAL_MESSAGE } from "../goal-state.js";
import { createTestClient } from "../test-client.js";
import { LEGACY_GOAL_FIXTURES, loadLegacyGoalFixture, type LegacyGoalFixtureName } from "../test-legacy-goals.js";
import type { GoalSnapshot, LegacyGoalSnapshot } from "./goal.js";

const SETTINGS = ["application.goals.v1", "application.goals.v2", "application.chain-runs.v1"] as const;
const EXPECTED: Record<LegacyGoalFixtureName, { planVersion: number; title: string; brief: string; status: string; stages: string[]; finished: boolean }> = {
  "v1-completed": { planVersion: 1, title: "The skateboard champion", brief: "make a funny video of a dog on a skateboard, three 10s clips", status: "completed", stages: ["videos"], finished: false },
  "v2-four-panel": { planVersion: 2, title: "The skateboard champion", brief: "make a funny video of a dog on a skateboard, two 10s clips", status: "completed", stages: ["frame", "storyboards", "storyboards", "videos", "videos"], finished: false },
  "v2-six-panel": { planVersion: 2, title: "The skateboard champion", brief: "interview with a giant microphone", status: "completed", stages: ["frame", "storyboards", "videos"], finished: false },
  "v3-finished": { planVersion: 3, title: "skate through the morning market", brief: "skate through the morning market", status: "completed", stages: ["frame", "videos"], finished: true },
  "v3-running": { planVersion: 3, title: "glide over the harbour at dusk", brief: "glide over the harbour at dusk", status: "failed", stages: ["frame"], finished: false },
};

describe("goals made by an earlier /goal", () => {
  let root: string;
  let client: Client;
  let engine: Engine;
  let bookId: string;
  let notebookId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-goal-legacy-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    bookId = engine.book.get().bookId;
    const notebook = await engine.notebooks.create("Goals");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
  });

  afterEach(async () => {
    await client?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const raw = (args: Record<string, unknown>) => client.callTool({ name: "video_goal", arguments: { book_id: bookId, notebook_id: notebookId, ...args } });
  const textOf = (result: { content?: unknown }) => (result.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
  async function invoke(args: Record<string, unknown>): Promise<GoalSnapshot> {
    const result = await raw(args);
    expect(result.isError, textOf(result)).toBeFalsy();
    return JSON.parse(textOf(result)) as GoalSnapshot;
  }
  async function legacy(args: Record<string, unknown>): Promise<LegacyGoalSnapshot> {
    const goal = await invoke(args);
    if (!goal.legacy) throw new Error("expected an earlier goal");
    return goal;
  }
  function bookState() {
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    return {
      cells: JSON.stringify(notebook.value.cells),
      edges: JSON.stringify(notebook.value.edges),
      artifacts: engine.artifacts.list().map(artifact => artifact.artifactId).sort(),
      settings: Object.fromEntries(SETTINGS.map(key => [key, engine.settings.get<Record<string, unknown>>(key)])),
    };
  }

  it.each(LEGACY_GOAL_FIXTURES)("keeps the %s goal as a read-only tile without deleting or rewriting the book", async (name) => {
    const expected = EXPECTED[name];
    const { goalId, artifactIds } = await loadLegacyGoalFixture(engine, notebookId, name);
    const before = bookState();
    const goal = await legacy({ action: "status", goal_id: goalId });
    expect(goal).toMatchObject({ legacy: true, kind: "video-goal", goalId, planVersion: expected.planVersion, title: expected.title, status: expected.status, address: "@b1" });
    expect(goal.brief).toContain(expected.brief);
    expect(goal.outputs.map(output => output.stage)).toEqual(expected.stages);
    const document = engine.notebooks.read(notebookId);
    if (!document.ok) throw new Error(document.error.message);
    for (const output of goal.outputs) {
      const cell = document.value.cells.find(candidate => candidate.id === output.cellId);
      expect(cell?.outputArtifactId).toBe(output.artifactId);
      expect(output.address).toMatch(/^@[a-z]+\d$/u);
      expect([...artifactIds.values()]).toContain(output.artifactId);
    }
    if (expected.finished) expect(goal.finalArtifactId).toEqual(expect.any(String));
    else expect(goal.finalArtifactId).toBeNull();
    expect(goal).not.toHaveProperty("stages");
    expect(goal).not.toHaveProperty("plan");

    for (const action of ["approve", "regenerate", "revise", "select", "update", "retry", "finish"]) {
      const refused = await raw({ action, goal_id: goalId, revision: 1, stage: "frame", index: 0, feedback: "brighter", artifact_id: goal.outputs[0]?.artifactId ?? goalId });
      expect(refused.isError, action).toBe(true);
      expect(textOf(refused), action).toBe(LEGACY_GOAL_MESSAGE);
    }
    expect(await legacy({ action: "cancel", goal_id: goalId })).toMatchObject({ status: expected.status });
    const listed = (JSON.parse(textOf(await raw({ action: "list" }))) as { goals: GoalSnapshot[] }).goals;
    expect(listed).toEqual([expect.objectContaining({ legacy: true, goalId, outputs: goal.outputs })]);
    const dismissed = await legacy({ action: "dismiss", goal_id: goalId });
    expect(dismissed.dismissedAt).toEqual(expect.any(String));

    const after = bookState();
    expect(after.cells).toBe(before.cells);
    expect(after.edges).toBe(before.edges);
    expect(after.artifacts).toEqual(before.artifacts);
    for (const key of SETTINGS) {
      const beforeKeys = Object.keys(before.settings[key] ?? {});
      const afterKeys = Object.keys(after.settings[key] ?? {});
      expect(beforeKeys.filter(id => !afterKeys.includes(id)), key).toEqual([]);
      expect(afterKeys.filter(id => !beforeKeys.includes(id)), key).toEqual(key === "application.goals.v2" && name === "v1-completed" ? [goalId] : []);
    }
    const stored = (store: Record<string, unknown> | null | undefined) => {
      const { status: _status, error: _error, dismissedAt: _dismissed, updatedAt: _updated, planVersion: _version, stage: _stage, stages: _stages, ...rest } = (store?.[goalId] ?? {}) as Record<string, unknown>;
      return rest;
    };
    const original = stored(before.settings["application.goals.v2"] ?? before.settings["application.goals.v1"]);
    expect(stored(after.settings["application.goals.v2"])).toEqual(original);
    if (name === "v1-completed") expect(after.settings["application.goals.v1"]).toEqual(before.settings["application.goals.v1"]);
  });

  it("stops a running earlier goal on its first read and keeps its completed outputs", async () => {
    const { goalId } = await loadLegacyGoalFixture(engine, notebookId, "v3-running");
    const chainId = String((engine.settings.get<Record<string, { chainId: string }>>("application.goals.v2") ?? {})[goalId]!.chainId);
    expect(getChainRun(engine, chainId)?.status).toBe("running");
    const listed = (JSON.parse(textOf(await raw({ action: "list" }))) as { goals: GoalSnapshot[] }).goals[0]!;
    expect(listed).toMatchObject({ legacy: true, status: "failed", error: LEGACY_GOAL_MESSAGE });
    expect(getChainRun(engine, chainId)?.status).toBe("cancelled");
    if (!listed.legacy) throw new Error("expected an earlier goal");
    expect(listed.outputs).toEqual([expect.objectContaining({ stage: "frame", address: expect.stringMatching(/^@/u) })]);
    const updatedAt = listed.updatedAt;
    expect((await legacy({ action: "status", goal_id: goalId })).updatedAt).toBe(updatedAt);
    expect((await legacy({ action: "dismiss", goal_id: goalId })).dismissedAt).toEqual(expect.any(String));
  });

  it("lists earlier goals beside new shorts, places them below existing cells, and offers no assembly or storyboard argument", async () => {
    const image = await engine.artifacts.create("image", "Existing");
    if (!image.ok) throw new Error(image.error.message);
    const written = await engine.files.write(image.value.artifactId, "original.png", await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123456" } }).png().toBuffer());
    if (!written.ok) throw new Error(written.error.message);
    const inserted = await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({ type: "image", label: "Existing", slot: { row: 0, column: 0 }, outputArtifactId: image.value.artifactId }));
    if (!inserted.ok) throw new Error(inserted.error.message);
    const { goalId } = await loadLegacyGoalFixture(engine, notebookId, "v2-six-panel");
    expect((await legacy({ action: "status", goal_id: goalId })).address).toBe("@c1");
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).not.toContain("assemble_goal");
    const goalTool = tools.tools.find(tool => tool.name === "video_goal")!;
    const schema = JSON.stringify(goalTool.inputSchema);
    for (const word of ["assemble", "combine", "shot_indexes", "storyboards"]) expect(schema).not.toContain(word);
    expect(goalTool.description).not.toMatch(/storyboard|seedance|nano banana|kie/iu);
  });
});
