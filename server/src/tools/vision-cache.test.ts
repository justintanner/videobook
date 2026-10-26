import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine, Job } from "videobook-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fileObjectHash, recordSidecarAnalysis } from "../analysis-sidecars.js";
import { createEngineForTest } from "../engine.js";
import { FFMPEG } from "../ffmpeg.js";
import { pauseBookQueueForTests, queue, resumeBookQueueForTests, waitForBookJob, waitForBookQueuesIdleForTests } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";
import { IMAGE_DESCRIPTION, imageDescriptionRecord, VIDEO_ANALYSIS, videoAnalysisInputs, videoAnalysisRecord } from "../vision-components.js";

const execFileAsync = promisify(execFile);

type TextContent = Array<{ type: string; text: string }>;

interface ToolStatus {
  status: string;
  job_id: number | null;
  script_asset_id?: string;
  count?: number;
}

const ANALYSIS = {
  summary: "A man answers a phone in a kitchen.",
  scenes: [{ timestamp: 0, description: "Phone call", tags: ["phone"] }],
  tags: ["phone", "kitchen"],
  mood: "tense",
  subjects: ["man"],
  setting: "a kitchen",
};

const DESCRIPTION = { prompt: "A red teapot on a wooden table, soft window light.", shot: "close-up", pose: "", tags: [] };

describe("vision analysis components", () => {
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

  async function artifact(kind: "video" | "image", file: string, bytes: Buffer): Promise<string> {
    const created = await engine.artifacts.create(kind, `${kind} source`);
    if (!created.ok) throw new Error(created.error.message);
    await write(created.value.artifactId, file, bytes);
    return created.value.artifactId;
  }

  async function analysed(artifactId: string, withTranscript: boolean): Promise<void> {
    await write(artifactId, ".original.analysis.json", JSON.stringify(ANALYSIS));
    const inputs = await videoAnalysisInputs(engine, artifactId, withTranscript);
    if (!inputs) throw new Error("video missing");
    await recordSidecarAnalysis(engine, VIDEO_ANALYSIS, {
      ...videoAnalysisRecord(engine, artifactId, inputs),
      provenance: { analyzer: "test", provider: null, model: null },
    });
  }

  function jobsFor(type: string, key: string, artifactId: string): Job[] {
    return engine.jobs.queue.list({ type, limit: 500 }).filter((job) => job.payload[key] === artifactId);
  }

  async function settled(jobId: number): Promise<Job> {
    await waitForBookJob(bookId, jobId, testBudget(30_000)).catch(() => undefined);
    const job = engine.jobs.queue.get(jobId);
    if (!job) throw new Error(`job ${jobId} missing`);
    return job;
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
    tempDir = await mkdtemp(join(tmpdir(), "videobook-vision-cache-"));
    await queue.start();
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    bookId = engine.book.get().bookId;
  });

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await resumeBookQueueForTests(bookId).catch(() => undefined);
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(30_000) }).catch(() => undefined);
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("serves a video analysis for the current video and transcript without a key, job or write", async () => {
    const assetId = await artifact("video", "original.mp4", Buffer.from("analysed video"));
    await analysed(assetId, false);
    const before = await fileObjectHash(engine, assetId, ".original.analysis.json");

    expect(await call("analyze_video", { asset_id: assetId })).toMatchObject({ status: "cached", job_id: null });
    expect(jobsFor("analyze_video", "assetId", assetId)).toEqual([]);
    expect(await fileObjectHash(engine, assetId, ".original.analysis.json")).toBe(before);

    await write(assetId, "elevenlabs.json", JSON.stringify({ language_code: "eng", words: [] }));
    await expect(call("analyze_video", { asset_id: assetId })).rejects.toThrow("OPENAI_API_KEY");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const queued = await paused(() => call("analyze_video", { asset_id: assetId }));
    expect(queued).toMatchObject({ status: "queued" });
  });

  it("adopts an earlier real analysis but never an empty fallback", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const real = await artifact("video", "original.mp4", Buffer.from("real analysis"));
    await write(real, ".original.analysis.json", JSON.stringify(ANALYSIS));
    expect(await call("analyze_video", { asset_id: real })).toMatchObject({ status: "cached" });

    const empty = await artifact("video", "original.mp4", Buffer.from("fallback analysis"));
    await write(empty, ".original.analysis.json", JSON.stringify({ summary: "", scenes: [], tags: [], subjects: [], setting: "" }));
    expect(await paused(() => call("analyze_video", { asset_id: empty }))).toMatchObject({ status: "queued" });
  });

  it("shares a forced re-analysis and keeps the previous analysis when it fails", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const assetId = await artifact("video", "original.mp4", Buffer.from("refresh video"));
    await write(assetId, "original_frames/0.000.jpg", Buffer.from("frame"));
    await analysed(assetId, false);
    const before = await fileObjectHash(engine, assetId, ".original.analysis.json");

    const [first, second] = await paused(() => Promise.all([
      call("analyze_video", { asset_id: assetId, force: true }),
      call("analyze_video", { asset_id: assetId, force: true }),
    ]));
    expect(second.job_id).toBe(first.job_id);
    const job = await settled(first.job_id as number);
    expect(job.state).toBe("failed");
    expect(job.error?.message).toContain("previous analysis was kept");
    expect(await fileObjectHash(engine, assetId, ".original.analysis.json")).toBe(before);
    expect(await call("analyze_video", { asset_id: assetId })).toMatchObject({ status: "cached" });
  });

  it("finishes an automatic analysis job for an analysed video without the provider", async () => {
    const assetId = await artifact("video", "original.mp4", Buffer.from("slotted video"));
    await analysed(assetId, false);
    const job = await queue.enqueue(`auto-analyze-${assetId}`, {
      type: "analyze_video",
      assetId,
      assetDir: "",
      bookId,
      hasTranscription: false,
      purpose: "tagging",
    });
    const done = await settled(job.id);
    expect(done.state).toBe("done");
    expect(done.result).toMatchObject({ success: true, cached: true });
  });

  it("scans scenes once per video and reports the cached counts", async () => {
    const output = join(tempDir, "cut.mp4");
    await execFileAsync(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=12:d=1",
      "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=12:d=1",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", output,
    ]);
    const assetId = await artifact("video", "original.mp4", await readFile(output));

    const first = await call("detect_scenes", { source_asset_id: assetId });
    expect(first).toMatchObject({ status: "queued" });
    expect((await settled(first.job_id as number)).state).toBe("done");

    const cached = await call("detect_scenes", { source_asset_id: assetId });
    expect(cached).toMatchObject({ status: "cached", job_id: null });
    expect(cached.count).toEqual(expect.any(Number));
    expect(jobsFor("detect_scenes", "assetId", assetId)).toHaveLength(1);
    expect(await paused(() => call("detect_scenes", { source_asset_id: assetId, force: true }))).toMatchObject({ status: "queued" });
  }, testBudget(60_000));

  it("reuses one image description and one script asset across repeated requests", async () => {
    const assetId = await artifact("image", "original.png", Buffer.from("teapot pixels"));
    await write(assetId, ".original.analysis.json", JSON.stringify(DESCRIPTION));
    const imageHash = await fileObjectHash(engine, assetId, "original.png") as string;
    await recordSidecarAnalysis(engine, IMAGE_DESCRIPTION, {
      ...imageDescriptionRecord(engine, assetId, imageHash),
      provenance: { analyzer: "test", provider: null, model: null },
    });

    const first = await call("describe_image", { asset_id: assetId });
    expect(first).toMatchObject({ status: "cached", job_id: null });
    const script = await engine.files.read(first.script_asset_id as string, "original.md");
    expect(script.ok && script.value.toString()).toContain("A red teapot");
    const scripts = engine.artifacts.list().filter((entry) => entry.kind === "script").length;

    expect(await call("describe_image", { asset_id: assetId })).toMatchObject({ status: "cached", script_asset_id: first.script_asset_id });
    expect(engine.artifacts.list().filter((entry) => entry.kind === "script")).toHaveLength(scripts);
    expect(jobsFor("describe_image", "sourceAssetId", assetId)).toEqual([]);
  });

  it("joins concurrent image descriptions onto one job and one script", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const assetId = await artifact("image", "original.png", Buffer.from("lamp pixels"));
    const [first, second] = await paused(() => Promise.all([
      call("describe_image", { asset_id: assetId }),
      call("describe_image", { asset_id: assetId }),
    ]));
    expect(first).toMatchObject({ status: "queued" });
    expect(second.job_id).toBe(first.job_id);
    expect(second.script_asset_id).toBe(first.script_asset_id);
    expect(jobsFor("describe_image", "sourceAssetId", assetId)).toHaveLength(1);
  });
});
