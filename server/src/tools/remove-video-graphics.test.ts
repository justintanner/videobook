import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEngineForTest } from "../engine.js";
import { createApp } from "../app.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { pauseBookQueueForTests, resumeBookQueueForTests, waitForBookQueuesIdleForTests } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";
import { cleanupSampleTimes, trackCleanupRegions, validateCleanupRegions, type CleanupRegion } from "../video-cleanup/model.js";
import { cleanupModelStatus } from "../video-cleanup/models.js";
import { getCanonicalCommands } from "./commands.js";

const exec = promisify(execFile);
const REGION: CleanupRegion = { id: "title", x: 0.09, y: 0.4, width: 0.82, height: 0.25, start: 0.5, end: 1.5 };
const MODEL_TEST = process.env.VIDEOBOOK_RUN_CLEANUP_MODELS === "1";
type Read = { source: { source_hash: string }; detection: { status: string; jobId: number | null; value: { regions: CleanupRegion[] } | null } };
type Rendered = { request_id: string; job_id: number; status: string; output_asset_id: string; cell_id: string | null; error: string | null; progress: { completedFrames: number; totalFrames: number; elapsedSeconds: number } | null };

describe("remove_video_graphics", () => {
  let root = "", fixture = "", bookId = "", assetId = "", notebookId = "";
  let client: Client;
  let engine: Engine;
  const originalModelDir = process.env.VIDEOBOOK_CLEANUP_MODEL_DIR;

  async function ffmpeg(args: string[]): Promise<Buffer> {
    return (await exec(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "buffer", maxBuffer: 10_000_000, timeout: testBudget(60_000) })).stdout;
  }
  async function call<T>(args: Record<string, unknown>): Promise<T> {
    const result = await client.callTool({ name: "remove_video_graphics", arguments: { book_id: bookId, asset_id: assetId, notebook_id: notebookId, ...args } });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    if (result.isError) throw new Error(text);
    return JSON.parse(text) as T;
  }
  async function path(id: string): Promise<string> {
    const result = await engine.files.manifest(id);
    if (!result.ok) throw new Error(result.error.message);
    return join(result.value.path, "original.mp4");
  }
  async function whitePixels(video: string, time: number): Promise<number> {
    const frame = await ffmpeg(["-ss", String(time), "-i", video, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    let count = 0;
    for (let y = 128; y < 208; y++) for (let x = 40; x < 470; x++) {
      const at = (y * 512 + x) * 3;
      if (frame[at]! > 220 && frame[at + 1]! > 220 && frame[at + 2]! > 220) count++;
    }
    return count;
  }
  async function render(method: "fill" | "lama", regions = [REGION]): Promise<Rendered> {
    const read = await call<Read>({ op: "get" });
    const args = { op: "render", source_hash: read.source.source_hash, request_id: randomUUID(), method, regions };
    const queued = await call<Rendered>(args);
    expect(queued.output_asset_id).not.toBe(assetId);
    const repeated = await call<Rendered>(args);
    expect(repeated.job_id).toBe(queued.job_id);
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(180_000) });
    const done = await call<Rendered>({ op: "status", request_id: args.request_id });
    expect(done.status, done.error ?? "").toBe("completed");
    expect(done.progress).toMatchObject({ completedFrames: 12, totalFrames: 12 });
    return done;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-cleanup-test-"));
    if (!MODEL_TEST) process.env.VIDEOBOOK_CLEANUP_MODEL_DIR = join(root, "empty-models");
    fixture = join(root, "title.mp4");
    const overlay = join(root, "title.png");
    await sharp(Buffer.from('<svg width="512" height="320"><text x="60" y="180" font-family="Arial" font-size="42" fill="white">HELLO WORLD</text></svg>')).png().toFile(overlay);
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0x5688a1:s=512x320:r=6:d=2", "-i", overlay,
      "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.05:seed=9:duration=2:sample_rate=48000",
      "-filter_complex", "[0:v][1:v]overlay=0:0:enable='gte(t,0.5)*lt(t,1.5)'[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", fixture]);
    engine = createEngineForTest(root);
    bookId = engine.book.get().bookId;
    const created = await engine.artifacts.create("video", "Title fixture");
    if (!created.ok) throw new Error(created.error.message);
    assetId = created.value.artifactId;
    await engine.files.writeFromPath(assetId, "original.mp4", fixture);
    const notebook = await engine.notebooks.create("Cleanup");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({ type: "video", slot: { row: 0, column: 0 }, outputArtifactId: assetId }));
    client = await createTestClient(root);
  }, testBudget(60_000));

  afterAll(async () => {
    await client?.close();
    if (originalModelDir === undefined) delete process.env.VIDEOBOOK_CLEANUP_MODEL_DIR;
    else process.env.VIDEOBOOK_CLEANUP_MODEL_DIR = originalModelDir;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("offers the editor aliases and refuses stale or invalid regions before creating outputs", async () => {
    expect(getCanonicalCommands().find((c) => c.command === "/remove-graphics")?.uiAction).toBe("open_video_cleanup");
    const before = engine.jobs.queue.list({ type: "remove_video_graphics" }).length;
    const read = await call<Read>({ op: "get" });
    await expect(call({ op: "render", method: "fill", source_hash: "stale", request_id: randomUUID(), regions: [REGION] })).rejects.toThrow("changed");
    await expect(call({ op: "render", method: "fill", source_hash: read.source.source_hash, request_id: randomUUID(), regions: [{ ...REGION, end: 20 }] })).rejects.toThrow("inside the video");
    await expect(call({ op: "render", method: "fill", source_hash: read.source.source_hash, request_id: randomUUID(), regions: [] })).rejects.toThrow("at least one");
    expect(engine.jobs.queue.list({ type: "remove_video_graphics" })).toHaveLength(before);
  });

  it("removes timed text locally, keeps audio packets and source bytes, and makes a playable notebook copy", async () => {
    const before = await engine.files.read(assetId, "original.mp4");
    const done = await render("fill");
    const output = await path(done.output_asset_id);
    expect(await whitePixels(fixture, 1)).toBeGreaterThan(500);
    expect(await whitePixels(output, 1)).toBeLessThan(30);
    const probe = await probeVideo(output);
    expect(probe).toMatchObject({ width: 512, height: 320, fps: 6, hasAudio: true });
    expect(probe.videoDuration).toBeCloseTo(2, 2);
    const hashAudio = (file: string) => ffmpeg(["-i", file, "-map", "0:a", "-c", "copy", "-f", "md5", "pipe:1"]);
    expect((await hashAudio(output)).toString()).toBe((await hashAudio(fixture)).toString());
    const after = await engine.files.read(assetId, "original.mp4");
    expect(after.ok && before.ok && after.value.equals(before.value)).toBe(true);
    const manifest = await engine.files.manifest(done.output_asset_id);
    expect(manifest.ok && manifest.value.files.map((f) => f.name)).toEqual(expect.arrayContaining(["original.mp4", "original.jpg", "proxy.mp4", "video-cleanup.json"]));
    const notebook = engine.notebooks.read(notebookId);
    expect(notebook.ok && notebook.value.cells.find((c) => c.id === done.cell_id)?.inputs?.sourceArtifactId).toBe(assetId);
  }, testBudget(60_000));

  it("reuses an equivalent reviewed recipe across request IDs and rejects a modified derivative", async () => {
    const source = await call<Read>({ op: "get" });
    const original = await render("fill");
    const count = engine.jobs.queue.list({ type: "remove_video_graphics" }).length;
    const reused = await call<Rendered>({ op: "render", request_id: randomUUID(), source_hash: source.source.source_hash, method: "fill", regions: [{ ...REGION, id: "renamed-region" }] });
    expect(reused.status).toBe("completed");
    expect(reused.output_asset_id).toBe(original.output_asset_id);
    expect(reused.job_id).toBe(original.job_id);
    expect(engine.jobs.queue.list({ type: "remove_video_graphics" })).toHaveLength(count);
    await engine.files.writeFromPath(original.output_asset_id, "original.mp4", fixture);
    await expect(call({ op: "render", request_id: original.request_id, source_hash: source.source.source_hash, method: "fill", regions: [REGION] })).rejects.toThrow("changed after rendering");
    const fresh = await render("fill");
    expect(fresh.output_asset_id).not.toBe(original.output_asset_id);
  }, testBudget(60_000));

  it("leaves an overlay outside the reviewed time window", async () => {
    const done = await render("fill", [{ ...REGION, start: 0.9, end: 1.2 }]);
    expect(await whitePixels(await path(done.output_asset_id), 0.67)).toBeGreaterThan(500);
    expect(await whitePixels(await path(done.output_asset_id), 1)).toBeLessThan(30);
  }, testBudget(60_000));

  it("can cancel a queued removal without changing the original", async () => {
    pauseBookQueueForTests(bookId);
    try {
      const read = await call<Read>({ op: "get" });
      const requestId = randomUUID();
      const queued = await call<Rendered>({ op: "render", method: "fill", source_hash: read.source.source_hash, request_id: requestId, regions: [{ ...REGION, end: 1.6 }] });
      await client.callTool({ name: "cancel_job", arguments: { book_id: bookId, job_id: queued.job_id } });
      expect((await call<Rendered>({ op: "status", request_id: requestId })).status).toBe("failed");
      expect(await readFile(await path(assetId))).toEqual(await readFile(fixture));
    } finally { resumeBookQueueForTests(bookId); }
  });

  it("refuses a changed source at execution and leaves no rendered media", async () => {
    const altered = join(root, "changed.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "color=red:s=512x320:r=6:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", altered]);
    pauseBookQueueForTests(bookId);
    const requestId = randomUUID();
    let outputId = "";
    try {
      const read = await call<Read>({ op: "get" });
      const queued = await call<Rendered>({ op: "render", method: "fill", source_hash: read.source.source_hash, request_id: requestId, regions: [{ ...REGION, end: 1.7 }] });
      outputId = queued.output_asset_id;
      await engine.files.writeFromPath(assetId, "original.mp4", altered);
    } finally { resumeBookQueueForTests(bookId); }
    try {
      await waitForBookQueuesIdleForTests({ budgetMs: testBudget(30_000) });
      const result = await call<Rendered>({ op: "status", request_id: requestId });
      expect(result.status).toBe("failed");
      expect(result.error).toContain("changed");
      const manifest = await engine.files.manifest(outputId);
      expect(manifest.ok && manifest.value.files.some((f) => f.name === "original.mp4")).toBe(false);
      expect(await readFile(await path(assetId))).toEqual(await readFile(altered));
    } finally { await engine.files.writeFromPath(assetId, "original.mp4", fixture); }
  }, testBudget(60_000));

  it("requires an explicit local model download and never silently uses a provider", async () => {
    const previous = process.env.VIDEOBOOK_CLEANUP_MODEL_DIR;
    process.env.VIDEOBOOK_CLEANUP_MODEL_DIR = join(root, "missing-models");
    try {
      await expect(call({ op: "detect" })).rejects.toThrow("Download the local models");
      const read = await call<Read>({ op: "get" });
      await expect(call({ op: "render", method: "lama", source_hash: read.source.source_hash, request_id: randomUUID(), regions: [REGION] })).rejects.toThrow("Download the local models");
    } finally {
      if (previous === undefined) delete process.env.VIDEOBOOK_CLEANUP_MODEL_DIR;
      else process.env.VIDEOBOOK_CLEANUP_MODEL_DIR = previous;
    }
  });

  it.runIf(MODEL_TEST)("detects real title frames with PaddleOCR and removes them with LaMa, entirely locally", async () => {
    expect(await cleanupModelStatus()).toMatchObject({ detector: true, lama: true });
    await call({ op: "detect", force: true });
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(120_000) });
    const read = await call<Read>({ op: "get" });
    expect(read.detection.status).toBe("ready");
    const regions = read.detection.value!.regions;
    expect(regions.length).toBeGreaterThan(0);
    expect(regions[0]!.start).toBe(0.5);
    expect(regions[0]!.end).toBe(1.5);
    const app = createApp({ ui: false });
    const server = app.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    let running = true;
    const latencies: number[] = [];
    const health = (async () => {
      while (running) {
        const started = performance.now();
        const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
        expect(response.status).toBe(200);
        await response.arrayBuffer();
        latencies.push(performance.now() - started);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    })();
    let done: Rendered;
    try {
      done = await render("lama", regions);
    } finally {
      running = false;
      await health;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await app.mcpHandler.close();
    }
    expect(latencies.length).toBeGreaterThan(5);
    expect(Math.max(...latencies)).toBeLessThan(1000);
    expect(await whitePixels(await path(done.output_asset_id), 1)).toBeLessThan(30);
    const audio = (file: string) => ffmpeg(["-i", file, "-map", "0:a", "-c", "copy", "-f", "md5", "pipe:1"]);
    expect((await audio(await path(done.output_asset_id))).toString()).toBe((await audio(fixture)).toString());
    expect(await readFile(await path(assetId))).toEqual(await readFile(fixture));
  }, testBudget(240_000));

  it.runIf(MODEL_TEST)("cancels running model inference after reporting frame progress", async () => {
    const read = await call<Read>({ op: "get" });
    const requestId = randomUUID();
    const queued = await call<Rendered>({ op: "render", method: "lama", source_hash: read.source.source_hash, request_id: requestId, regions: [{ ...REGION, end: 1.8 }] });
    await expect.poll(async () => (await call<Rendered>({ op: "status", request_id: requestId })).progress?.completedFrames ?? 0,
      { timeout: testBudget(120_000) }).toBeGreaterThan(3);
    const started = performance.now();
    await client.callTool({ name: "cancel_job", arguments: { book_id: bookId, job_id: queued.job_id } });
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(15_000) });
    expect(performance.now() - started).toBeLessThan(testBudget(10_000));
    expect((await call<Rendered>({ op: "status", request_id: requestId })).status).toBe("failed");
    const manifest = await engine.files.manifest(queued.output_asset_id);
    expect(manifest.ok && manifest.value.files.some(file => file.name === "original.mp4")).toBe(false);
    expect(await readFile(await path(assetId))).toEqual(await readFile(fixture));
  }, testBudget(180_000));
});

describe("timed removal regions", () => {
  it("separates appearances across gaps and bounds sampling", () => {
    const box = { x: 0.2, y: 0.5, width: 0.4, height: 0.1 };
    const tracked = trackCleanupRegions([{ time: 0.25, boxes: [box] }, { time: 0.75, boxes: [box] }, { time: 1.25, boxes: [] }, { time: 1.75, boxes: [box] }], 0.5, 2);
    expect(tracked.map((r) => [r.start, r.end])).toEqual([[0, 1], [1.5, 2]]);
    expect(cleanupSampleTimes(120).times).toHaveLength(240);
    expect(() => cleanupSampleTimes(1000, 0.25)).toThrow("600");
    expect(() => validateCleanupRegions([{ ...REGION, x: 0.9 }], 2)).toThrow();
    expect(() => validateCleanupRegions([REGION, REGION], 2)).toThrow();
  });
});
