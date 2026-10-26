import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine, Job } from "videobook-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidecarAnalysisSpec, SidecarInput } from "../analysis-sidecars.js";
import { recordSidecarAnalysis } from "../analysis-sidecars.js";
import { createEngineForTest } from "../engine.js";
import { pauseBookQueueForTests, queue, resumeBookQueueForTests, waitForBookJob, waitForBookQueuesIdleForTests } from "../queue.js";
import { JOKES, jokesRecord, SUGGESTED_CUTS, SUGGESTED_SFX, suggestionRecord } from "../suggestion-components.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";

type TextContent = Array<{ type: string; text: string }>;

interface ToolStatus {
  status: string;
  job_id: number | null;
  summary?: string;
  trims?: number;
  sfx?: number;
  jokes?: number;
}

const TRANSCRIPT = {
  language_code: "eng",
  text: "Why did the chicken cross the road?",
  words: [
    { text: "Why", start: 0.2, end: 0.4, type: "word" },
    { text: " ", start: 0.4, end: 0.4, type: "spacing" },
    { text: "chicken?", start: 0.4, end: 0.9, type: "word" },
  ],
};

describe("suggestion and joke components", () => {
  let client: Client;
  let engine: Engine;
  let bookId: string;
  let tempDir: string;

  async function call(name: string, args: Record<string, unknown>): Promise<ToolStatus> {
    const result = await client.callTool({ name, arguments: { book_id: bookId, ...args } });
    const text = (result.content as TextContent)[0].text;
    if (result.isError) throw new Error(text);
    return JSON.parse(text) as ToolStatus;
  }

  async function write(artifactId: string, name: string, content: string | Buffer): Promise<void> {
    const written = await engine.files.write(artifactId, name, content);
    if (!written.ok) throw new Error(written.error.message);
  }

  async function video(label: string): Promise<string> {
    const created = await engine.artifacts.create("video", label);
    if (!created.ok) throw new Error(created.error.message);
    const artifactId = created.value.artifactId;
    await write(artifactId, "original.mp4", Buffer.from(label));
    await write(artifactId, "original_frames/0.500.jpg", Buffer.from("frame"));
    await write(artifactId, "elevenlabs.json", JSON.stringify(TRANSCRIPT));
    return artifactId;
  }

  async function stored(spec: SidecarAnalysisSpec, record: SidecarInput, document: object): Promise<void> {
    await write(record.artifactId, spec.sidecar, JSON.stringify(document));
    await recordSidecarAnalysis(engine, spec, { ...record, provenance: { analyzer: "test", provider: null, model: null } });
  }

  function jobs(type: string, artifactId: string): Job[] {
    return engine.jobs.queue.list({ type, limit: 500 }).filter((job) => job.payload.assetId === artifactId);
  }

  async function paused<T>(run: () => Promise<T>): Promise<T> {
    await pauseBookQueueForTests(bookId);
    try {
      return await run();
    } finally {
      await resumeBookQueueForTests(bookId);
    }
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-suggestion-cache-"));
    await queue.start();
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    bookId = engine.book.get().bookId;
  });

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await resumeBookQueueForTests(bookId).catch(() => undefined);
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(20_000) }).catch(() => undefined);
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("reuses cut suggestions per video, transcript and instructions", async () => {
    const assetId = await video("cuts source");
    await stored(SUGGESTED_CUTS, await suggestionRecord(engine, SUGGESTED_CUTS, assetId, { instructions: "tighter pacing" }), {
      trims: [{ cut_start: 1, cut_end: 1.4, reason: "Dead air", severity: "high" }],
      summary: "One pause trimmed.",
    });

    expect(await call("suggest_cuts", { asset_id: assetId, instructions: " tighter pacing " }))
      .toMatchObject({ status: "cached", job_id: null, trims: 1, summary: "One pause trimmed." });
    expect(jobs("suggest_cuts", assetId)).toEqual([]);

    expect(await paused(() => call("suggest_cuts", { asset_id: assetId, instructions: "smoother transitions" })))
      .toMatchObject({ status: "queued" });
    await write(assetId, "elevenlabs.json", JSON.stringify({ ...TRANSCRIPT, text: "Edited" }));
    expect(await paused(() => call("suggest_cuts", { asset_id: assetId, instructions: "tighter pacing" })))
      .toMatchObject({ status: "queued" });
  });

  it("shares a forced sound-effect review and keeps the earlier suggestions when it fails", async () => {
    const assetId = await video("sfx source");
    const record = await suggestionRecord(engine, SUGGESTED_SFX, assetId, {});
    await stored(SUGGESTED_SFX, record, { sfx: [{ timestamp: 0.5, description: "whoosh" }], summary: "One whoosh." });

    expect(await call("suggest_sfx", { asset_id: assetId })).toMatchObject({ status: "cached", sfx: 1 });
    const [first, second] = await paused(() => Promise.all([
      call("suggest_sfx", { asset_id: assetId, force: true }),
      call("suggest_sfx", { asset_id: assetId, force: true }),
    ]));
    expect(second.job_id).toBe(first.job_id);
    await waitForBookJob(bookId, first.job_id as number, testBudget(20_000)).catch(() => undefined);
    expect(engine.jobs.queue.get(first.job_id as number)?.state).toBe("failed");
    expect(await call("suggest_sfx", { asset_id: assetId })).toMatchObject({ status: "cached", sfx: 1 });
  });

  it("keys jokes by the timed transcript and finishes automatic repeats without the provider", async () => {
    const assetId = await video("jokes source");
    await stored(JOKES, await jokesRecord(engine, assetId), { jokes: [{ text: "Why did the chicken" }], summary: "One joke." });

    expect(await call("analyze_jokes", { asset_id: assetId })).toMatchObject({ status: "cached", jokes: 1 });
    const job = await queue.enqueue(`analyze-jokes-${assetId}-repeat`, { type: "analyze_jokes", assetId, assetDir: "", bookId });
    await waitForBookJob(bookId, job.id, testBudget(20_000)).catch(() => undefined);
    expect(engine.jobs.queue.get(job.id)).toMatchObject({ state: "done", result: { success: true, cached: true } });

    await write(assetId, "elevenlabs.json", JSON.stringify({ ...TRANSCRIPT, text: "A different take" }));
    expect(await paused(() => call("analyze_jokes", { asset_id: assetId }))).toMatchObject({ status: "queued" });
  });
});
