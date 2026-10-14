import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Engine } from "videobook-engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { coldOpenCacheKey, coldOpenSource } from "../cold-open.js";
import { coldOpenRangeError } from "../cold-open-model.js";
import { createEngineForTest, closeEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { registerAllJobHandlers } from "../jobs/index.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { INTELLIGENCE_MODEL } from "../openai-intelligence.js";
import { queue, setEngineRoot } from "../queue.js";
import { coldOpenDefs } from "./cold-open.js";
import type { ToolResult } from "./tool-def.js";

const exec = promisify(execFile);
const value = (result: ToolResult): Record<string, unknown> => {
  if (result.isError) throw new Error(result.content[0]!.text);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
};

describe("reviewed cold-open copies", () => {
  let fixtureRoot: string;
  let root: string;
  let engine: Engine;
  let bookId: string;
  let assetId: string;
  let notebookId: string;
  let sourceHash: string;
  let sourcePath: string;
  const call = async (name: string, args: Record<string, unknown> = {}) => coldOpenDefs(engine).find(tool => tool.name === name)!.handler({ book_id: bookId, asset_id: assetId, notebook_id: notebookId, ...args });
  const edit = (args: Record<string, unknown> = {}) => call("edit_cold_open", { source_object_hash: sourceHash, start_time: 2, end_time: 4, request_id: randomUUID(), ...args });
  const done = async (jobId: unknown) => {
    await expect.poll(() => engine.jobs.queue.get(Number(jobId))?.state, { timeout: 45_000 }).toMatch(/done|failed|aborted/);
    const job = engine.jobs.queue.get(Number(jobId))!;
    expect(job.error).toBeNull();
    expect(job.state).toBe("done");
    return job.result as { output_asset_id: string; duration: number; cell_id: string; address: string };
  };

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "cold-open-fixtures-"));
    await exec(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=24:duration=6",
      "-f", "lavfi", "-i", "aevalsrc=0.25*sin(2*PI*if(lt(t\\,2)\\,440\\,if(lt(t\\,4)\\,880\\,1320))*t):s=48000:d=6",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(fixtureRoot, "source.mp4")]);
    await exec(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=blue:size=96x160:rate=24:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(fixtureRoot, "silent.mp4")]);
  });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cold-open-test-"));
    engine = createEngineForTest(root);
    registerAllJobHandlers(engine);
    await setEngineRoot(root, engine);
    bookId = engine.book.get().bookId;
    const source = await engine.artifacts.create({ kind: "video", label: "Original" });
    if (!source.ok) throw new Error(source.error.message);
    assetId = source.value.artifactId;
    await engine.files.writeFromPath(assetId, "original.mp4", join(fixtureRoot, "source.mp4"));
    const manifest = await engine.files.manifest(assetId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    sourcePath = join(manifest.value.path, "original.mp4");
    sourceHash = manifest.value.files.find(file => file.name === "original.mp4")!.objectHash;
    await registerMediaProbe(engine, assetId, "original.mp4", await probeVideo(sourcePath));
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({ type: "video", slot: { row: 0, column: 0 }, outputArtifactId: assetId }));
  });
  afterEach(async () => {
    await queue.stop();
    closeEngineForTest(root, engine);
    await rm(root, { recursive: true, force: true });
  });
  afterAll(async () => { await rm(fixtureRoot, { recursive: true, force: true }); });

  it("reuses a source-versioned suggestion without creating media or spending again", async () => {
    const source = await coldOpenSource(engine, assetId);
    const suggestion = { sourceArtifactId: assetId, sourceObjectHash: sourceHash, durationSeconds: 6, fps: 24, startSeconds: 2, endSeconds: 4, reason: "The action peaks here", model: INTELLIGENCE_MODEL };
    engine.settings.set(coldOpenCacheKey(source), suggestion);
    const before = engine.artifacts.list().length;
    expect(value(await call("prepare_cold_open"))).toEqual({ status: "ready", suggestion });
    expect(engine.jobs.queue.list({ type: "prepare_cold_open" })).toHaveLength(0);
    expect(engine.artifacts.list()).toHaveLength(before);
    await engine.files.write(assetId, "elevenlabs.json", JSON.stringify({ words: [{ text: "New dialogue", start: 2, end: 3 }] }));
    expect(coldOpenCacheKey(await coldOpenSource(engine, assetId))).not.toBe(coldOpenCacheKey(source));
  });

  it("renders highlight then the complete source, with matching sound and one idempotent output cell", async () => {
    const requestId = randomUUID();
    const queued = value(await edit({ request_id: requestId }));
    const repeated = value(await edit({ request_id: requestId }));
    expect(repeated.output_asset_id).toBe(queued.output_asset_id);
    const output = await done(queued.job_id);
    expect(output.address).toBe("@b1");
    expect(output.duration).toBeCloseTo(8, 1);
    expect(output.output_asset_id).not.toBe(assetId);
    const manifest = await engine.files.manifest(output.output_asset_id);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const outputPath = join(manifest.value.path, "original.mp4");
    const probe = await probeVideo(outputPath);
    expect(probe).toMatchObject({ width: 160, height: 96, fps: 24, hasAudio: true });
    expect(manifest.value.files.some(file => file.name === "original.jpg")).toBe(true);
    const frame = async (path: string, time: number) => (await exec(FFMPEG, ["-v", "error", "-ss", String(time), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: 2_000_000 })).stdout;
    for (const [outputTime, sourceTime] of [[0.5, 2.5], [2.5, 0.5], [5, 3], [7.5, 5.5]]) {
      const a = await frame(outputPath, outputTime!);
      const b = await frame(sourcePath, sourceTime!);
      expect(a.length).toBe(b.length);
      expect(a.reduce((sum, channel, index) => sum + Math.abs(channel - b[index]!), 0) / a.length).toBeLessThan(6);
    }
    for (const [time, frequency] of [[0.5, 880], [2.5, 440], [4.5, 880], [6.5, 1320]]) {
      const pcm = (await exec(FFMPEG, ["-v", "error", "-ss", String(time), "-i", outputPath, "-t", "0.25", "-vn", "-ar", "48000", "-ac", "1", "-f", "s16le", "pipe:1"], { encoding: "buffer" })).stdout;
      let crossings = 0;
      for (let offset = 2; offset < pcm.length; offset += 2) if (pcm.readInt16LE(offset - 2) <= 0 && pcm.readInt16LE(offset) > 0) crossings += 1;
      expect(Math.abs(crossings / 0.25 - frequency!)).toBeLessThan(15);
    }
    expect(value(await edit({ request_id: requestId })).job_id).toBe(queued.job_id);
    const notebook = engine.notebooks.read(notebookId);
    expect(notebook.ok && notebook.value.cells).toHaveLength(2);
    expect((await coldOpenSource(engine, assetId)).file.objectHash).toBe(sourceHash);
    expect(engine.artifacts.list()).toHaveLength(2);
  }, 60_000);

  it("keeps short portrait video silent and places its copy in a free slot", async () => {
    await engine.files.writeFromPath(assetId, "original.mp4", join(fixtureRoot, "silent.mp4"));
    await registerMediaProbe(engine, assetId, "original.mp4", await probeVideo(join(fixtureRoot, "silent.mp4")));
    sourceHash = (await coldOpenSource(engine, assetId)).file.objectHash;
    await engine.notebooks.insertCell(notebookId, engine.notebooks.createCell({ type: "video", slot: { row: 1, column: 0 }, outputArtifactId: assetId }));
    const output = await done(value(await edit({ start_time: 0, end_time: 1 })).job_id);
    expect(output.address).toBe("@a2");
    const manifest = await engine.files.manifest(output.output_asset_id);
    if (!manifest.ok) throw new Error(manifest.error.message);
    expect(await probeVideo(join(manifest.value.path, "original.mp4"))).toMatchObject({ width: 96, height: 160, hasAudio: false, videoDuration: 2 });
  });

  it("rejects invalid ranges, changed sources, and reused request IDs without making extra copies", async () => {
    for (const args of [{ start_time: -1 }, { start_time: 5, end_time: 7 }, { start_time: 2, end_time: 2.1 }, { source_object_hash: "stale" }]) {
      expect((await edit(args)).isError).toBe(true);
      expect(engine.artifacts.list()).toHaveLength(1);
    }
    const requestId = randomUUID();
    await done(value(await edit({ request_id: requestId })).job_id);
    expect((await edit({ request_id: requestId, start_time: 1 })).isError).toBe(true);
    expect(engine.artifacts.list()).toHaveLength(2);
    expect(coldOpenRangeError(Number.NaN, 2, 6)).not.toBeNull();
  });

  it("reports missing credentials without marking the source as failed", async () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const result = await call("prepare_cold_open");
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("OPENAI_API_KEY");
      expect(engine.artifacts.list()).toHaveLength(1);
      expect(engine.jobs.queue.list({ type: "prepare_cold_open" })).toHaveLength(0);
      await expect(queue.enqueueAndWait("cold-open-missing-key", {
        type: "prepare_cold_open", bookId, sourceArtifactId: assetId, sourceObjectHash: sourceHash,
        cacheKey: coldOpenCacheKey(await coldOpenSource(engine, assetId)),
      })).rejects.toThrow("OPENAI_API_KEY");
      const failure = await engine.jobs.failures.read(assetId);
      expect(failure.ok && failure.value).toBeNull();
    } finally {
      if (original !== undefined) process.env.OPENAI_API_KEY = original;
    }
  });

  it("resumes a cancelled render with the same output identity", async () => {
    const requestId = randomUUID();
    const initial = value(await edit({ request_id: requestId }));
    expect(await engine.jobs.queue.abort(Number(initial.job_id), "Cancelled by test")).toBe(true);
    await queue.stop();
    const retry = value(await edit({ request_id: requestId }));
    expect(retry.output_asset_id).toBe(initial.output_asset_id);
    const output = await done(retry.job_id);
    expect(output.output_asset_id).toBe(initial.output_asset_id);
    expect(engine.artifacts.list()).toHaveLength(2);
    const notebook = engine.notebooks.read(notebookId);
    expect(notebook.ok && notebook.value.cells).toHaveLength(2);
  });

  it("preflights notebook capacity before analysis or creating an artifact", async () => {
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const cells = Array.from({ length: 512 }, (_, index) => engine.notebooks.createCell({
      type: "video", slot: { row: Math.floor(index / 8), column: index % 8 },
      ...(index === 0 ? { outputArtifactId: assetId } : {}),
    }));
    const filled = await engine.notebooks.write({ ...notebook.value, cells });
    expect(filled.ok).toBe(true);
    for (const response of [await call("prepare_cold_open"), await edit()]) {
      expect(response.isError).toBe(true);
      expect(response.content[0]!.text).toContain("one empty cell");
    }
    expect(engine.artifacts.list()).toHaveLength(1);
  });
});
