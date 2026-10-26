import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AnalysisComponentSpec } from "../analysis-components.js";
import { readAnalysisComponent, writeAnalysisComponent } from "../analysis-components.js";
import { cachedSidecarAnalysis, fileObjectHash, recordSidecarAnalysis } from "../analysis-sidecars.js";
import { createEngineForTest } from "../engine.js";
import { queue, waitForBookQueuesIdleForTests } from "../queue.js";
import { SOUND_SIDECARS } from "../stale-sidecars.js";
import { SUGGESTED_CUTS, suggestionRecord } from "../suggestion-components.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";
import { DEFAULT_TRANSCRIPT_OPTIONS, elevenLabsTranscriptRecord, ELEVENLABS_TRANSCRIPT, recordElevenLabsTranscript } from "../transcript-components.js";
import { VIDEO_ANALYSIS, videoAnalysisInputs, videoAnalysisRecord } from "../vision-components.js";

type TextContent = Array<{ type: string; text: string }>;

const PROBE: AnalysisComponentSpec = { component: "retention-probe", version: 1, jobType: "retention_probe" };
const anyValue = z.object({ index: z.number() });
const provenance = { analyzer: "test", provider: null, model: null };
const TRANSCRIPT = { language_code: "eng", text: "Rain on the roof.", words: [{ text: "Rain", start: 0.1, end: 0.4, type: "word" }] };
const ANALYSIS = { summary: "Rain on a tin roof.", scenes: [{ timestamp: 0, description: "Roof", tags: [] }], tags: ["rain"], subjects: [], setting: "a roof" };
const CUTS = { trims: [{ cut_start: 1, cut_end: 1.5, reason: "Dead air", severity: "high" }], summary: "One pause." };

describe("analysis retention and undo", () => {
  let client: Client;
  let engine: Engine;
  let bookId: string;
  let tempDir: string;
  let artifactId: string;

  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await client.callTool({ name, arguments: { book_id: bookId, ...args } });
    const text = (result.content as TextContent)[0].text;
    if (result.isError) throw new Error(text);
    return JSON.parse(text) as Record<string, unknown>;
  }

  async function write(name: string, content: string | Buffer): Promise<void> {
    const written = await engine.files.write(artifactId, name, content);
    if (!written.ok) throw new Error(written.error.message);
  }

  function probe(key: string, sourceHash: string, index: number): void {
    writeAnalysisComponent(engine, {
      component: PROBE.component, key, artifactId, sourceHash,
      provenance: { ...provenance, version: 1, createdAt: new Date().toISOString() },
      value: { index },
    });
  }

  function kept(keys: readonly string[]): string[] {
    return keys.filter((key) => readAnalysisComponent(engine, PROBE, key, anyValue) !== null);
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-analysis-retention-"));
    await queue.start();
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    bookId = engine.book.get().bookId;
    const created = await engine.artifacts.create("video", "rain");
    if (!created.ok) throw new Error(created.error.message);
    artifactId = created.value.artifactId;
  });

  beforeEach(() => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(20_000) }).catch(() => undefined);
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("keeps every result for the three most recent source hashes of a component", () => {
    const keys = ["k1", "k2", "k3", "k4", "k5", "k6"];
    probe("k1", "a", 1);
    probe("k2", "a", 2);
    probe("k3", "b", 3);
    probe("k4", "c", 4);
    expect(kept(keys)).toEqual(["k1", "k2", "k3", "k4"]);
    probe("k5", "d", 5);
    expect(kept(keys)).toEqual(["k3", "k4", "k5"]);
    probe("k3", "b", 3);
    probe("k6", "e", 6);
    expect(kept(keys)).toEqual(["k3", "k5", "k6"]);
  });

  it("serves the transcript, analysis and suggestions again after an edit is undone", async () => {
    await write("original.mp4", Buffer.from("first cut"));
    await write("original.mp3", Buffer.from("first cut audio"));
    await write("original_frames/0.500.jpg", Buffer.from("frame"));
    await write("elevenlabs.json", JSON.stringify(TRANSCRIPT));
    await write(".original.analysis.json", JSON.stringify(ANALYSIS));
    await write(".suggest-cuts.json", JSON.stringify(CUTS));
    const audioHash = await fileObjectHash(engine, artifactId, "original.mp3") as string;
    await recordElevenLabsTranscript(engine, { artifactId, audioHash, options: DEFAULT_TRANSCRIPT_OPTIONS });
    const analysisInputs = await videoAnalysisInputs(engine, artifactId, true);
    await recordSidecarAnalysis(engine, VIDEO_ANALYSIS, { ...videoAnalysisRecord(engine, artifactId, analysisInputs!), provenance });
    await recordSidecarAnalysis(engine, SUGGESTED_CUTS, { ...await suggestionRecord(engine, SUGGESTED_CUTS, artifactId, { instructions: null }), provenance });
    const beforeEdit = engine.history.artifact(artifactId)[0]?.hash;
    if (!beforeEdit) throw new Error("missing revision");

    await write("original.mp4", Buffer.from("second cut"));
    await write("original.mp3", Buffer.from("second cut audio"));
    for (const name of SOUND_SIDECARS) await engine.files.delete(artifactId, name);
    const editedAudio = await fileObjectHash(engine, artifactId, "original.mp3") as string;
    expect(await cachedSidecarAnalysis(engine, ELEVENLABS_TRANSCRIPT, elevenLabsTranscriptRecord({ artifactId, audioHash: editedAudio, options: DEFAULT_TRANSCRIPT_OPTIONS }))).toBe(false);
    expect(await cachedSidecarAnalysis(engine, SUGGESTED_CUTS, await suggestionRecord(engine, SUGGESTED_CUTS, artifactId, { instructions: null }))).toBe(false);

    await call("restore_asset_version", { asset_id: artifactId, commit_hash: beforeEdit });
    expect(await call("transcribe", { asset_id: artifactId })).toMatchObject({ status: "cached", job_id: null });
    expect(await call("analyze_video", { asset_id: artifactId })).toMatchObject({ status: "cached", job_id: null });
    expect(await call("suggest_cuts", { asset_id: artifactId })).toMatchObject({ status: "cached", trims: CUTS.trims });
    expect(engine.jobs.queue.list({ limit: 500 }).filter((job) => job.payload.assetId === artifactId)).toEqual([]);
  });
});
