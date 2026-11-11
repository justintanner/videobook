import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import sharp from "sharp";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { generateTimestamps } from "../frame-utils.js";
import { waitForBookQueuesIdleForTests } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";
import { processRenderedVideo, writeRenderedVideo } from "./_render-output.js";

const execFileAsync = promisify(execFile);
const WIDTH = 360;
const HEIGHT = 640;

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("a rendered copy", () => {
  let tempDir: string;
  let client: Client;
  let engine: Engine;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-render-output-"));
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
  }, testBudget(60_000));

  afterAll(async () => {
    await client?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }, testBudget(60_000));

  it("gets the proxy, frames and audio of a processed video, so doctor finds nothing to rebuild", async () => {
    const clip = join(tempDir, "graphics.mp4");
    await execFileAsync(FFMPEG, [
      "-y", "-f", "lavfi", "-i", `testsrc=duration=2:size=${WIDTH}x${HEIGHT}:rate=24`,
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
    ]);
    const artifactId = value(await engine.artifacts.create("video", "Street — Graphics")).artifactId;
    const probe = await writeRenderedVideo(engine, artifactId, clip, new AbortController().signal);
    const written = value(await engine.files.manifest(artifactId)).files;
    const poster = written.find((file) => file.name === "original.jpg")?.objectHash;
    expect(written.map((file) => file.name).sort()).toEqual(["original.jpg", "original.mp4"]);

    const provenance = { origin: "graphics", request_id: "render-request-1", rendered_at: "2026-11-11T13:00:00.000Z" };
    await processRenderedVideo(engine, engine.book.get().bookId, artifactId, provenance);
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(120_000) });

    const jobs = engine.jobs.queue.list({ type: "process_video", artifactId });
    expect(jobs.map((job) => [job.state, job.payload.skipDownstreamJobs])).toEqual([["done", true]]);
    const manifest = value(await engine.files.manifest(artifactId));
    expect(manifest.files.find((file) => file.name === "original.jpg")?.objectHash).toBe(poster);
    expect(manifest.files.map((file) => file.name)).toEqual(expect.arrayContaining(["original.mp4", "original.mp3", "proxy.mp4"]));
    const frames = manifest.files.filter((file) => file.name.startsWith("original_frames/"));
    expect(frames).toHaveLength(generateTimestamps(probe.duration).length);
    for (const frame of frames) {
      expect(await sharp(value(await engine.files.read(artifactId, frame.name))).metadata()).toMatchObject({ format: "jpeg", width: WIDTH, height: HEIGHT });
    }
    const proxy = await probeVideo(join(manifest.path, "proxy.mp4"));
    expect(proxy.hasAudio).toBe(true);
    expect(Math.abs(proxy.videoDuration - probe.videoDuration)).toBeLessThan(0.1);
    expect((await engine.metadata.artifacts.read(artifactId, "proxy")).ok).toBe(true);
    expect((await engine.metadata.waveforms.read(artifactId)).ok).toBe(true);
    expect(value(await engine.metadata.artifacts.read(artifactId, "original"))).toMatchObject({ ...provenance, width: WIDTH, height: HEIGHT, hasAudio: true });
    expect(value(await engine.status.get(artifactId))).toBe("ready");

    const doctor = await client.callTool({ name: "doctor", arguments: { book_id: engine.book.get().bookId, asset_id: artifactId, fix: true } });
    const text = (doctor.content as Array<{ type: string; text: string }>)[0].text;
    expect(doctor.isError === true, text).toBe(false);
    expect(JSON.parse(text)).toMatchObject({ status: "already_healthy", asset_status: "ready" });
  }, testBudget(120_000));
});
