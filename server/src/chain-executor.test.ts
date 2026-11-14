import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZodRawShape } from "zod";
import type { Engine } from "videobook-engine";
import { preflightAndAccept, resumeOpenChains, retryChainRun, waitForChainRun, type ChainRunRecord } from "./chain-executor.js";
import { closeEngineForTest, createEngineForTest } from "./engine.js";
import { testBudget } from "./test-budget.js";
import { getAllToolDefs } from "./tools/index.js";
import type { ToolDef } from "./tools/tool-def.js";

const RUNS_KEY = "application.chain-runs.v1";
const LABELS = ["first", "second", "third"];

describe("chain executor failure policy", () => {
  let root: string;
  let engine: Engine;
  let bookId: string;
  let notebookId: string;
  let artifactIds: string[];
  let manifest: ToolDef;
  const failing = new Set<string>();
  const calls: string[] = [];
  const lookup = (name: string) => name === "asset_manifest" ? manifest : undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-chain-executor-"));
    engine = createEngineForTest(root);
    bookId = engine.book.get().bookId;
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    artifactIds = [];
    for (const [column, label] of LABELS.entries()) {
      const created = await engine.artifacts.create("image", label);
      if (!created.ok) throw new Error(created.error.message);
      const inserted = await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({ type: "image", slot: { row: 0, column }, outputArtifactId: created.value.artifactId }));
      if (!inserted.ok) throw new Error(inserted.error.message);
      artifactIds.push(created.value.artifactId);
    }
    failing.clear();
    calls.length = 0;
    const real = getAllToolDefs(engine).find((def) => def.name === "asset_manifest")!;
    manifest = {
      ...real,
      handler: async (args) => {
        const id = String(args.asset_id);
        calls.push(id);
        if (failing.has(id)) return { isError: true, content: [{ type: "text", text: `${LABELS[artifactIds.indexOf(id)]} refused` }] };
        return { content: [{ type: "text", text: JSON.stringify({ artifactId: id, path: root, files: [] }) }] };
      },
    };
  });

  afterEach(async () => {
    closeEngineForTest(root, engine);
    await rm(root, { recursive: true, force: true });
  });

  async function run(continueOnFailure = false): Promise<ChainRunRecord> {
    const accepted = await preflightAndAccept({
      action: "run", version: 1, book_id: bookId, notebook_id: notebookId,
      steps: LABELS.map((id, index) => ({ id, tool: "asset_manifest", params: { asset_id: artifactIds[index] } })),
    }, {
      engine, bookId, notebookId,
      toolSchemas: new Map<string, ZodRawShape>([["asset_manifest", manifest.schema]]),
      autoApplyTools: new Set(["asset_manifest"]),
      effectForTool: () => "read",
      ...(continueOnFailure ? { continueOnFailure: true } : {}),
    }, lookup);
    return waitForChainRun(engine, accepted.chainId, testBudget(15_000));
  }

  const statuses = (record: ChainRunRecord) => record.steps.map((step) => step.status);

  it("stops at the first failed step unless the plan continues past failures", async () => {
    failing.add(artifactIds[0]!);
    const stopped = await run();
    expect(stopped).toMatchObject({ status: "failed", error: "first refused" });
    expect(stopped).not.toHaveProperty("continueOnFailure");
    expect(statuses(stopped)).toEqual(["failed", "skipped", "skipped"]);
    expect(calls).toEqual([artifactIds[0]]);

    calls.length = 0;
    const continued = await run(true);
    expect(continued).toMatchObject({ status: "failed", error: "first refused", continueOnFailure: true });
    expect(continued.steps.map((step) => [step.status, step.error])).toEqual([["failed", "first refused"], ["completed", null], ["completed", null]]);
    expect(calls).toEqual(artifactIds);
  });

  it("counts every failure, and a retry sends only the steps that failed", async () => {
    failing.add(artifactIds[0]!);
    failing.add(artifactIds[2]!);
    const failed = await run(true);
    expect(failed).toMatchObject({ status: "failed", error: "2 of 3 steps failed. first refused" });
    expect(statuses(failed)).toEqual(["failed", "completed", "failed"]);

    failing.clear();
    calls.length = 0;
    retryChainRun(engine, failed.chainId, lookup);
    const retried = await waitForChainRun(engine, failed.chainId, testBudget(15_000));
    expect(retried).toMatchObject({ status: "completed", error: null });
    expect(statuses(retried)).toEqual(["completed", "completed", "completed"]);
    expect(calls).toEqual([artifactIds[0], artifactIds[2]]);
  });

  it("continues past failures when a stopped run is retried with the option", async () => {
    failing.add(artifactIds[0]!);
    const stopped = await run();
    calls.length = 0;
    retryChainRun(engine, stopped.chainId, lookup, { continueOnFailure: true });
    const retried = await waitForChainRun(engine, stopped.chainId, testBudget(15_000));
    expect(retried).toMatchObject({ status: "failed", error: "first refused", continueOnFailure: true });
    expect(statuses(retried)).toEqual(["failed", "completed", "completed"]);
    expect(calls).toEqual(artifactIds);
  });

  it("never sends a failed step again when an unfinished run resumes", async () => {
    failing.add(artifactIds[0]!);
    const finished = await run(true);
    const store = engine.settings.get<{ runs: Record<string, ChainRunRecord>; requestIndex: Record<string, string> }>(RUNS_KEY)!;
    const record = store.runs[finished.chainId]!;
    store.runs[finished.chainId] = {
      ...record, status: "running", error: null,
      steps: record.steps.map((step, index) => index === 2 ? { ...step, status: "pending", outputs: null } : step),
    };
    const written = engine.settings.set(RUNS_KEY, store);
    if (!written.ok) throw new Error(written.error.message);

    failing.clear();
    calls.length = 0;
    resumeOpenChains(engine, lookup);
    const resumed = await waitForChainRun(engine, finished.chainId, testBudget(15_000));
    expect(calls).toEqual([artifactIds[2]]);
    expect(resumed).toMatchObject({ status: "failed", error: "first refused" });
    expect(statuses(resumed)).toEqual(["failed", "completed", "completed"]);
  });
});
