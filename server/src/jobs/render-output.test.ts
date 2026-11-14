import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import sharp from "sharp";
import type { Engine } from "videobook-engine";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readAnalysisComponent } from "../analysis-components.js";
import { cachedSidecarAnalysis, fileObjectHash } from "../analysis-sidecars.js";
import { captionMediaSource } from "../captions/source.js";
import { createEngineForTest } from "../engine.js";
import { extractMp3, FFMPEG, probeVideo } from "../ffmpeg.js";
import { generateTimestamps } from "../frame-utils.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { pauseBookQueueForTests, resumeBookQueueForTests, waitForBookQueuesIdleForTests } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";
import { reconcileProjectWork } from "../tools/reconcile-project-work.js";
import {
  DEFAULT_TRANSCRIPT_OPTIONS,
  ELEVENLABS_TRANSCRIPT,
  elevenLabsTranscriptKey,
  hasCurrentElevenLabsTranscript,
  OPENAI_TRANSCRIPT,
  openAiTranscriptKey,
  openAiTranscriptRecord,
  recordElevenLabsTranscript,
  recordOpenAiTranscript,
} from "../transcript-components.js";
import { processRenderedVideo, writeRenderedVideo } from "./_render-output.js";

const execFileAsync = promisify(execFile);
const WIDTH = 360;
const HEIGHT = 640;
const PLAIN = ".analysis.gpt4otrans.json";
const TIMED = "elevenlabs.json";
const TRANSCRIPT = {
  language_code: "eng",
  words: [
    { text: "Hello", start: 0.2, end: 0.6, type: "word" },
    { text: "world.", start: 0.7, end: 1.2, type: "word" },
  ],
};
const recordValue = z.object({ sidecarHash: z.string() });

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("a rendered copy", () => {
  let tempDir: string;
  let client: Client;
  let engine: Engine;
  let bookId: string;
  let clips = 0;

  async function clip(seconds = 2): Promise<string> {
    clips += 1;
    const path = join(tempDir, `clip-${clips}.mp4`);
    await execFileAsync(FFMPEG, [
      "-y", "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=${WIDTH}x${HEIGHT}:rate=24`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}:sample_rate=48000`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
    ]);
    return path;
  }

  async function rendered(source: string, seconds?: number): Promise<string> {
    clips += 1;
    const path = join(tempDir, `render-${clips}.mp4`);
    await execFileAsync(FFMPEG, [
      "-y", "-i", source, ...(seconds === undefined ? [] : ["-t", String(seconds)]),
      "-vf", "drawbox=x=0:y=0:w=80:h=80:color=red:t=fill",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ac", "2", path,
    ]);
    return path;
  }

  async function sourceVideo(label: string, path: string, transcribed: boolean): Promise<string> {
    const artifactId = value(await engine.artifacts.create("video", label)).artifactId;
    value(await engine.files.writeFromPath(artifactId, "original.mp4", path));
    await registerMediaProbe(engine, artifactId, "original.mp4", await probeVideo(path));
    const mp3 = join(tempDir, `${artifactId}.mp3`);
    await extractMp3(path, mp3);
    value(await engine.files.writeFromPath(artifactId, "original.mp3", mp3));
    if (!transcribed) return artifactId;
    value(await engine.files.write(artifactId, PLAIN, JSON.stringify({ text: "Hello world." })));
    value(await engine.files.write(artifactId, TIMED, JSON.stringify(TRANSCRIPT)));
    const audioHash = await audioOf(artifactId);
    await recordOpenAiTranscript(engine, artifactId, audioHash);
    await recordElevenLabsTranscript(engine, { artifactId, audioHash, options: DEFAULT_TRANSCRIPT_OPTIONS });
    return artifactId;
  }

  async function audioOf(artifactId: string): Promise<string> {
    const hash = await fileObjectHash(engine, artifactId, "original.mp3");
    if (!hash) throw new Error(`original.mp3 missing from ${artifactId}`);
    return hash;
  }

  async function renderCopy(sourceId: string, path: string): Promise<string> {
    const artifactId = value(await engine.artifacts.create("video", "Street — Graphics")).artifactId;
    await writeRenderedVideo(engine, artifactId, path, await captionMediaSource(engine, sourceId), new AbortController().signal);
    return artifactId;
  }

  async function original(artifactId: string): Promise<Record<string, unknown>> {
    return value(await engine.metadata.artifacts.read<Record<string, unknown>>(artifactId, "original"));
  }

  function transcriptJobs(artifactId: string) {
    return [
      ...engine.jobs.queue.list({ type: "transcribe_video_audio", artifactId }),
      ...engine.jobs.queue.list({ type: "transcribe", artifactId }),
    ];
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-render-output-"));
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    bookId = engine.book.get().bookId;
  }, testBudget(60_000));

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await resumeBookQueueForTests(bookId).catch(() => undefined);
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(30_000) }).catch(() => undefined);
    await client?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }, testBudget(60_000));

  it("gets the proxy, frames and audio of a processed video, so doctor finds nothing to rebuild", async () => {
    const path = await clip();
    const sourceId = await sourceVideo("Street", path, false);
    const artifactId = value(await engine.artifacts.create("video", "Street — Graphics")).artifactId;
    const probe = await writeRenderedVideo(engine, artifactId, path, await captionMediaSource(engine, sourceId), new AbortController().signal);
    const written = value(await engine.files.manifest(artifactId)).files;
    const poster = written.find((file) => file.name === "original.jpg")?.objectHash;
    expect(written.map((file) => file.name).sort()).toEqual(["original.jpg", "original.mp4"]);

    const provenance = { origin: "graphics", request_id: "render-request-1", rendered_at: "2026-11-11T13:00:00.000Z" };
    await processRenderedVideo(engine, bookId, artifactId, provenance);
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
    expect(await original(artifactId)).toMatchObject({ ...provenance, width: WIDTH, height: HEIGHT, hasAudio: true });
    expect(value(await engine.status.get(artifactId))).toBe("ready");

    const doctor = await client.callTool({ name: "doctor", arguments: { book_id: bookId, asset_id: artifactId, fix: true } });
    const text = (doctor.content as Array<{ type: string; text: string }>)[0].text;
    expect(doctor.isError === true, text).toBe(false);
    expect(JSON.parse(text)).toMatchObject({ status: "already_healthy", asset_status: "ready" });
  }, testBudget(120_000));

  it("takes over its source's transcripts under its own audio, so reconcile queues no speech-to-text", async () => {
    const path = await clip();
    const sourceId = await sourceVideo("Interview", path, true);
    const artifactId = await renderCopy(sourceId, await rendered(path));

    const audioHash = await audioOf(artifactId);
    expect(audioHash).not.toBe(await audioOf(sourceId));
    for (const name of [PLAIN, TIMED]) expect(await fileObjectHash(engine, artifactId, name)).toBe(await fileObjectHash(engine, sourceId, name));
    const copied = { provider: null, model: null, copiedFrom: sourceId };
    expect(readAnalysisComponent(engine, OPENAI_TRANSCRIPT, openAiTranscriptKey(audioHash), recordValue)).toMatchObject({
      artifactId, sourceHash: audioHash, provenance: { ...copied, analyzer: "transcript-openai-copy" },
    });
    expect(readAnalysisComponent(engine, ELEVENLABS_TRANSCRIPT, elevenLabsTranscriptKey(audioHash, DEFAULT_TRANSCRIPT_OPTIONS), recordValue)).toMatchObject({
      artifactId, sourceHash: audioHash, provenance: { ...copied, analyzer: "transcript-elevenlabs-copy" },
    });
    expect(await original(artifactId)).not.toHaveProperty("transcribe");

    await processRenderedVideo(engine, bookId, artifactId, { origin: "graphics", request_id: "render-request-2" });
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(120_000) });
    expect(engine.jobs.queue.list({ type: "process_video", artifactId }).map((job) => [job.state, job.payload.preserveAudioArtifacts])).toEqual([["done", true]]);
    expect(await audioOf(artifactId)).toBe(audioHash);
    expect(await cachedSidecarAnalysis(engine, OPENAI_TRANSCRIPT, openAiTranscriptRecord(artifactId, audioHash))).toBe(true);
    expect(await hasCurrentElevenLabsTranscript(engine, { artifactId, audioHash, options: DEFAULT_TRANSCRIPT_OPTIONS })).toBe(true);

    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    await pauseBookQueueForTests(bookId);
    try {
      const result = await reconcileProjectWork(engine, bookId);
      expect([...result.auto_plain_transcript, ...result.auto_transcribe].map((entry) => entry.assetId)).not.toContain(artifactId);
      expect(transcriptJobs(artifactId)).toEqual([]);
      expect(transcriptJobs(sourceId)).toEqual([]);
    } finally {
      await resumeBookQueueForTests(bookId);
    }
  }, testBudget(120_000));

  it("declines automatic speech-to-text when the source has none or the timeline changed, but still transcribes when asked", async () => {
    const path = await clip();
    const untranscribed = await sourceVideo("Market", path, false);
    const fromUntranscribed = await renderCopy(untranscribed, await rendered(path));
    const transcribed = await sourceVideo("Harbour", path, true);
    const shortened = await renderCopy(transcribed, await rendered(path, 1));
    for (const artifactId of [fromUntranscribed, shortened]) {
      expect(await original(artifactId)).toMatchObject({ hasAudio: true, transcribe: false });
      expect(await fileObjectHash(engine, artifactId, PLAIN)).toBeNull();
      expect(await fileObjectHash(engine, artifactId, TIMED)).toBeNull();
      await processRenderedVideo(engine, bookId, artifactId, { origin: "captions", request_id: `render-${artifactId}` });
    }
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(120_000) });
    for (const artifactId of [fromUntranscribed, shortened]) expect(await original(artifactId)).toMatchObject({ origin: "captions", transcribe: false });

    vi.stubEnv("OPENAI_API_KEY", "test-key");
    await pauseBookQueueForTests(bookId);
    try {
      const result = await reconcileProjectWork(engine, bookId);
      const queued = result.auto_plain_transcript.map((entry) => entry.assetId);
      expect(queued).toContain(untranscribed);
      expect(queued).not.toContain(fromUntranscribed);
      expect(queued).not.toContain(shortened);
      expect(transcriptJobs(untranscribed)).toHaveLength(1);
      expect(transcriptJobs(fromUntranscribed)).toEqual([]);
      expect(transcriptJobs(shortened)).toEqual([]);

      const asked = await client.callTool({ name: "transcribe", arguments: { book_id: bookId, asset_id: fromUntranscribed } });
      const text = (asked.content as Array<{ type: string; text: string }>)[0].text;
      expect(asked.isError === true, text).toBe(false);
      expect(JSON.parse(text)).toMatchObject({ asset_id: fromUntranscribed, provider: "openai", status: "queued", job_id: expect.any(Number) });
      expect(transcriptJobs(fromUntranscribed)).toHaveLength(1);
    } finally {
      await resumeBookQueueForTests(bookId);
    }
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(60_000) });
  }, testBudget(120_000));
});
