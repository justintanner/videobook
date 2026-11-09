import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine, type UsageEntry, type UsageInput } from "videobook-engine";
import { bookUsageDef } from "./book-usage.js";
import { getAllToolDefs } from "./index.js";

const RUN = "01990000-0000-7000-8000-0000000000aa";
const CELL = "01990000-0000-7000-8000-0000000000bb";
const OTHER_CELL = "01990000-0000-7000-8000-0000000000cc";

describe("usage cost by notebook cell, run and job", () => {
  let rootDir: string;
  let engine: Engine;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "usage-cost-scopes-"));
    engine = createEngine({ rootDir, initialBookName: "usage-scopes", durableWrites: false });
    await engine.ready;
  });

  afterEach(async () => {
    engine.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  function record(input: UsageInput): void {
    const written = engine.usage.record(input);
    if (!written.ok) throw new Error(written.error.message);
  }

  async function usage(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const result = await bookUsageDef(engine).handler({ book_id: engine.book.get().bookId, ...args });
    return JSON.parse(result.content[0]!.text!) as Record<string, unknown>;
  }

  function seedRun(): void {
    record({ id: "a", provider: "machgen", model: "Seedance-2.5", activity: "video", status: "completed", basis: "reported", actualBasis: "stated", costUsd: 0.4, estimateUsd: 0.45, cellId: CELL, runId: RUN, createdAt: 1 });
    record({ id: "b", provider: "openai", model: "gpt-5.6", activity: "chat", status: "completed", basis: "estimated", actualBasis: "derived", costUsd: 0.41, estimateUsd: 0.42, inputTokens: 1200, outputTokens: 300, tokenBased: true, cellId: CELL, runId: RUN, createdAt: 2 });
    record({ id: "c", provider: "wavespeed", model: "runwayml/aleph-2", activity: "video", status: "pending", basis: "estimated", costUsd: 1.85, estimateUsd: 1.85, cellId: OTHER_CELL, runId: RUN, createdAt: 3 });
    record({ id: "d", provider: "openai", model: "gpt-5.6", activity: "chat", status: "completed", basis: "estimated", actualBasis: "derived", costUsd: 0.01, estimateUsd: 0.01, inputTokens: 10, outputTokens: 5, tokenBased: true, createdAt: 4 });
  }

  it("adds a cell's and a run's quoted estimates, actuals and calls beside the book totals", async () => {
    seedRun();
    const scoped = await usage({ scope: { cell_id: CELL, run_id: RUN } });
    expect(scoped.rollup).toMatchObject({ count: 4, pendingCount: 1, unsettled: 1, pendingEstimateUsd: 1.85 });
    expect(scoped.cell).toMatchObject({ id: CELL, totals: { count: 2, unsettled: 0, pendingCount: 0 } });
    const cell = scoped.cell as { totals: { actualUsd: number; settledEstimateUsd: number }; calls: UsageEntry[] };
    expect(cell.totals.actualUsd).toBeCloseTo(0.81, 9);
    expect(cell.totals.settledEstimateUsd).toBeCloseTo(0.87, 9);
    expect(cell.calls.map((call) => [call.id, call.actualBasis, call.estimateUsd])).toEqual([["a", "stated", 0.45], ["b", "derived", 0.42]]);
    const run = scoped.run as { id: string; totals: Record<string, number>; calls: UsageEntry[] };
    expect(run.id).toBe(RUN);
    expect(run.totals).toMatchObject({ count: 3, unsettled: 1, pendingCount: 1, pendingEstimateUsd: 1.85 });
    expect(run.calls.map((call) => call.id)).toEqual(["a", "b", "c"]);
    const book = await usage();
    expect(book).not.toHaveProperty("cell");
    expect(book).not.toHaveProperty("run");
    expect(book.recent).toHaveLength(4);
  });

  it("lists each job with the usage its own calls recorded", async () => {
    const generating = engine.jobs.queue.enqueue({ type: "generate_media", payload: { type: "generate_media" } }).job;
    const waveform = engine.jobs.queue.enqueue({ type: "extract_waveform", payload: { type: "extract_waveform" } }).job;
    record({ id: "a", provider: "openai", model: "gpt-5.6", activity: "chat", status: "completed", basis: "estimated", actualBasis: "derived", costUsd: 0.41, estimateUsd: 0.42, inputTokens: 1200, outputTokens: 300, tokenBased: true, jobId: generating.operationId });
    record({ id: "b", provider: "wavespeed", model: "runwayml/aleph-2", activity: "video", status: "pending", basis: "estimated", costUsd: 1.85, estimateUsd: 1.85, jobId: generating.operationId });
    const listJobs = getAllToolDefs(engine).find((definition) => definition.name === "list_jobs")!;
    const listed = JSON.parse((await listJobs.handler({ book_id: engine.book.get().bookId })).content[0]!.text!) as Array<{ id: number; usage?: Record<string, unknown> }>;
    expect(listed.find((job) => job.id === generating.id)?.usage).toMatchObject({
      id: generating.operationId, count: 2, pendingCount: 1, unsettled: 1, actualUsd: 0.41, settledEstimateUsd: 0.42, pendingEstimateUsd: 1.85,
    });
    expect(listed.find((job) => job.id === waveform.id)).not.toHaveProperty("usage");
  });
});
