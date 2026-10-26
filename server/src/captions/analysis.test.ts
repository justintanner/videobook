import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { analysisComponentKey, readAnalysisComponent, writeAnalysisComponent } from "../analysis-components.js";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { missingFrameTimes, storeFrameRegions } from "../frame-regions.js";
import { pauseBookQueueForTests, queue, resumeBookQueueForTests, waitForBookJob, waitForBookQueuesIdleForTests } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";
import {
  CAPTION_REGIONS,
  CAPTION_TRANSCRIPT_JOB,
  CAPTION_VOCAL,
  captionAnalysisStateFor,
  prepareCaptionAnalysis,
  readCaptionTranscript,
  regionFrameRequests,
  regionsComponentKey,
  regionsValueSchema,
  vocalValueSchema,
} from "./analysis.js";
import { LEGACY_ALIVE_ANALYSIS_KEY } from "./legacy.js";
import { captionMediaSource } from "./source.js";

const execFileAsync = promisify(execFile);
const BURSTS = "sin(2*PI*440*t)*(0.8*between(t,0.5,0.8)+0.8*between(t,1.0,1.7)+0.2*between(t,2.5,2.8))";
const TRANSCRIPT = {
  language_code: "eng",
  words: [
    { text: "We", start: 0.5, end: 0.7, type: "word" },
    { text: " ", start: 0.7, end: 0.7, type: "spacing" },
    { text: "were", start: 0.7, end: 0.95, type: "word" },
    { text: "burning.", start: 1.05, end: 1.7, type: "word" },
    { text: "quiet", start: 2.5, end: 2.8, type: "word" },
  ],
};

describe("caption analysis components", () => {
  let client: Client;
  let engine: Engine;
  let bookId: string;
  let tempDir: string;
  let silent: Buffer;
  let mediaCount = 0;

  async function render(name: string, audio: boolean, color: string): Promise<Buffer> {
    mediaCount += 1;
    const output = join(tempDir, `${mediaCount}-${name}`);
    await execFileAsync(FFMPEG, [
      "-y", "-f", "lavfi", "-i", `color=c=${color}:s=320x180:r=24:d=3.2,drawbox=x=${mediaCount * 7}:y=10:w=20:h=20:c=white:t=fill`,
      ...(audio ? ["-f", "lavfi", "-i", `aevalsrc='${BURSTS}':s=44100:d=3.2`] : []),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      ...(audio ? ["-c:a", "aac", "-shortest"] : ["-an"]),
      output,
    ]);
    return readFile(output);
  }

  async function writeVideo(artifactId: string, bytes: Buffer): Promise<void> {
    const written = await engine.files.write(artifactId, "original.mp4", bytes);
    if (!written.ok) throw new Error(written.error.message);
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    await registerMediaProbe(engine, artifactId, "original.mp4", await probeVideo(join(manifest.value.path, "original.mp4")));
  }

  async function createVideo(bytes: Buffer, transcript: object | null): Promise<string> {
    const created = await engine.artifacts.create("video", "night drive");
    if (!created.ok) throw new Error(created.error.message);
    await writeVideo(created.value.artifactId, bytes);
    if (transcript) {
      const written = await engine.files.write(created.value.artifactId, "elevenlabs.json", JSON.stringify(transcript));
      if (!written.ok) throw new Error(written.error.message);
    }
    return created.value.artifactId;
  }

  async function speechVideo(transcript: object | null): Promise<string> {
    return createVideo(await render("speech.mp4", true, "gray"), transcript);
  }

  async function analysisState(artifactId: string) {
    return captionAnalysisStateFor(engine, await captionMediaSource(engine, artifactId));
  }

  function jobsOf(type: string, artifactId: string) {
    return engine.jobs.queue.list({ type, limit: 500 }).filter((job) => job.payload.sourceArtifactId === artifactId);
  }

  async function settled(artifactId: string, component: "vocal" | "regions", status: string) {
    await expect.poll(async () => (await analysisState(artifactId))[component]?.status, { timeout: testBudget(30_000) }).toBe(status);
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-caption-analysis-"));
    await queue.start();
    silent = await render("silent.mp4", false, "navy");
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    bookId = engine.book.get().bookId;
  });

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ELEVENLABS_API_KEY", "");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(20_000) }).catch(() => undefined);
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("measures vocal timing once, then serves the cached result without another job or write", async () => {
    const artifactId = await speechVideo(TRANSCRIPT);
    const first = await prepareCaptionAnalysis(engine, bookId, artifactId, { regions: true, languages: [], force: [] });
    expect(first.state.transcript).toMatchObject({ status: "ready", silent: false });
    expect(first.state.regions?.status).toBe("unavailable");
    await settled(artifactId, "vocal", "ready");
    const ready = await analysisState(artifactId);
    expect(ready.vocal?.provenance).toMatchObject({ analyzer: "caption-vocal-dsp", version: CAPTION_VOCAL.version, provider: null });
    expect(ready.vocal?.value?.words).toHaveLength(4);
    expect(ready.vocal?.value?.words[2].onset).toBeCloseTo(1, 1);
    expect(ready.vocal?.value?.onsets.length).toBeGreaterThan(0);
    const createdAt = ready.vocal?.provenance?.createdAt;
    await prepareCaptionAnalysis(engine, bookId, artifactId, { regions: true, languages: [], force: [] });
    expect(jobsOf(CAPTION_VOCAL.jobType, artifactId)).toHaveLength(1);
    expect((await analysisState(artifactId)).vocal?.provenance?.createdAt).toBe(createdAt);
    expect(engine.settings.get(`captions.prepare.${artifactId}`)).toBeNull();
  });

  it("shares one job between concurrent requests and reads status from the durable job table", async () => {
    const artifactId = await speechVideo(TRANSCRIPT);
    await pauseBookQueueForTests(bookId);
    try {
      await Promise.all([1, 2, 3].map(() => prepareCaptionAnalysis(engine, bookId, artifactId, { regions: false, languages: [], force: [] })));
      const jobs = jobsOf(CAPTION_VOCAL.jobType, artifactId);
      expect(jobs).toHaveLength(1);
      expect((await analysisState(artifactId)).vocal).toMatchObject({ status: "queued", jobId: jobs[0].id });
      await engine.jobs.queue.abort(jobs[0].id, "replaced by a row written outside this process");
      const source = await captionMediaSource(engine, artifactId);
      const direct = engine.jobs.queue.enqueue({
        type: CAPTION_VOCAL.jobType,
        payload: {
          type: CAPTION_VOCAL.jobType, bookId, sourceArtifactId: artifactId, mediaHash: source.mediaHash,
          transcriptHash: source.transcriptFile!.objectHash, componentKey: jobs[0].payload.componentKey, force: false,
        },
      });
      expect((await analysisState(artifactId)).vocal).toMatchObject({ status: "queued", jobId: direct.job.id });
    } finally {
      await resumeBookQueueForTests(bookId);
    }
    await settled(artifactId, "vocal", "ready");
  });

  it("deduplicates forced refreshes and keeps the last result when a refresh is cancelled", async () => {
    const artifactId = await speechVideo(TRANSCRIPT);
    await prepareCaptionAnalysis(engine, bookId, artifactId, { regions: false, languages: [], force: [] });
    await settled(artifactId, "vocal", "ready");
    const before = (await analysisState(artifactId)).vocal;
    await pauseBookQueueForTests(bookId);
    try {
      await prepareCaptionAnalysis(engine, bookId, artifactId, { regions: false, languages: [], force: ["vocal"] });
      await prepareCaptionAnalysis(engine, bookId, artifactId, { regions: false, languages: [], force: ["vocal"] });
      const refresh = jobsOf(CAPTION_VOCAL.jobType, artifactId).filter((job) => job.state === "queued");
      expect(refresh).toHaveLength(1);
      expect((await analysisState(artifactId)).vocal).toMatchObject({ status: "queued", value: before?.value });
      await engine.jobs.queue.abort(refresh[0].id, "cancelled by test");
    } finally {
      await resumeBookQueueForTests(bookId);
    }
    const after = (await analysisState(artifactId)).vocal;
    expect(after).toMatchObject({ status: "ready", error: expect.stringMatching(/cancel/i) });
    expect(after?.provenance?.createdAt).toBe(before?.provenance?.createdAt);
  });

  it("discards a result whose video changed before the job ran", async () => {
    const artifactId = await speechVideo(TRANSCRIPT);
    await pauseBookQueueForTests(bookId);
    let key: string | undefined;
    try {
      const prepared = await prepareCaptionAnalysis(engine, bookId, artifactId, { regions: false, languages: [], force: [] });
      key = prepared.state.vocal?.key;
      await writeVideo(artifactId, await render("changed.mp4", true, "red"));
    } finally {
      await resumeBookQueueForTests(bookId);
    }
    await expect.poll(() => jobsOf(CAPTION_VOCAL.jobType, artifactId)[0]?.state, { timeout: testBudget(30_000) }).toBe("failed");
    expect(jobsOf(CAPTION_VOCAL.jobType, artifactId)[0].error?.message).toMatch(/video changed/);
    expect(readAnalysisComponent(engine, CAPTION_VOCAL, key!, vocalValueSchema)).toBeNull();
    const fresh = await analysisState(artifactId);
    expect(fresh.vocal?.key).not.toBe(key);
    expect(fresh.vocal?.status).toBe("missing");
  });

  it("reports transcript availability and fails closed on placeholder keys without calling the provider", async () => {
    const artifactId = await speechVideo(null);
    const unavailable = await prepareCaptionAnalysis(engine, bookId, artifactId, { regions: false, languages: [], force: [] });
    expect(unavailable.state.transcript).toMatchObject({ status: "unavailable", error: expect.stringMatching(/ELEVENLABS_API_KEY/) });
    vi.stubEnv("ELEVENLABS_API_KEY", "test-caption-analysis");
    await prepareCaptionAnalysis(engine, bookId, artifactId, { regions: false, languages: [], force: [] });
    expect(jobsOf(CAPTION_TRANSCRIPT_JOB, artifactId)).toHaveLength(0);
    const source = await captionMediaSource(engine, artifactId);
    await queue.enqueue(`caption-transcript:${artifactId}:${source.mediaHash}`, {
      type: CAPTION_TRANSCRIPT_JOB, bookId, sourceArtifactId: artifactId, mediaHash: source.mediaHash, force: false,
    });
    await expect.poll(async () => (await analysisState(artifactId)).transcript.status, { timeout: testBudget(30_000) }).toBe("failed");
    const failed = await analysisState(artifactId);
    expect(failed.transcript.error).toMatch(/placeholder/);
    expect(failed.vocal).toBeNull();
    const manifest = await engine.files.manifest(artifactId);
    expect(manifest.ok && manifest.value.files.some((file) => file.name === "original.mp3")).toBe(true);
    expect(manifest.ok && manifest.value.files.some((file) => file.name === "elevenlabs.json")).toBe(false);
  });

  it("treats a video without audio as silent and needs no further work", async () => {
    const artifactId = await createVideo(silent, null);
    const prepared = await prepareCaptionAnalysis(engine, bookId, artifactId, { regions: true, languages: [], force: [] });
    expect(prepared.state).toMatchObject({ transcript: { status: "ready", silent: true }, vocal: null, regions: null });
    expect(engine.settings.get(`captions.prepare.${artifactId}`)).toBeNull();
  });

  it("imports a matching saved Alive analysis so its paid face and text regions are not requested again", async () => {
    const artifactId = await speechVideo(TRANSCRIPT);
    const source = await captionMediaSource(engine, artifactId);
    const transcriptBytes = Buffer.from(JSON.stringify(TRANSCRIPT));
    const fingerprint = createHash("sha256").update(JSON.stringify({
      version: 1,
      video: { name: source.file.name, size: source.file.sizeBytes, objectHash: source.file.objectHash },
      transcript: createHash("sha256").update(transcriptBytes).digest("hex"),
    })).digest("hex");
    const legacyWord = (text: string, start: number, end: number, onset: number) => ({ text, transcriptStart: start, transcriptEnd: end, onsetStart: onset, energy: 0.8 });
    const written = await engine.metadata.artifacts.write(artifactId, LEGACY_ALIVE_ANALYSIS_KEY, {
      version: 1, fingerprint, analyzedAt: new Date().toISOString(), durationSeconds: 3.2, sourceWidth: 320, sourceHeight: 180,
      envelopeHz: 20, envelope: [0, 0.5, 1], onsets: [0.5, 1], regionsAnalyzed: true,
      phrases: [{
        id: "p1", frameTime: 1.1,
        regions: [{ kind: "face", confidence: 0.9, x: 0.3, y: 0.2, width: 0.3, height: 0.4 }],
        lines: [[legacyWord("We", 0.5, 0.7, 0.5), legacyWord("were", 0.7, 0.95, 0.72)], [legacyWord("burning", 1.05, 1.7, 1)]],
      }],
    });
    if (!written.ok) throw new Error(written.error.message);
    const prepared = await prepareCaptionAnalysis(engine, bookId, artifactId, { regions: true, languages: [], force: [] });
    expect(prepared.state.regions).toMatchObject({ status: "ready", provenance: { analyzer: "alive-captions", provider: "openai" } });
    expect(prepared.state.regions?.value?.frames[0].regions[0]).toMatchObject({ kind: "face" });
    expect(prepared.state.vocal).toMatchObject({ status: "ready" });
    expect(prepared.state.vocal?.value?.words.map((word) => word.onset)).toEqual([0.5, 0.72, 1, 2.5]);
    expect(jobsOf(CAPTION_VOCAL.jobType, artifactId)).toHaveLength(0);
    expect(jobsOf(CAPTION_REGIONS.jobType, artifactId)).toHaveLength(0);
    expect(missingFrameTimes(engine, source.mediaHash, [1.1])).toEqual([]);
  });

  it("builds caption regions from frames that keyword or watermark placement already analysed", async () => {
    const artifactId = await speechVideo(TRANSCRIPT);
    const source = await captionMediaSource(engine, artifactId);
    const transcript = await readCaptionTranscript(engine, source);
    if (!transcript) throw new Error("transcript missing");
    const face = { kind: "face" as const, confidence: 0.9, x: 0.2, y: 0.1, width: 0.3, height: 0.4 };
    const times = regionFrameRequests(transcript.words, source.durationSeconds).map((request) => request.time);
    storeFrameRegions(engine, artifactId, source.mediaHash, times.map((time) => ({ time, regions: [face] })));

    const job = await queue.enqueue(`caption-regions-${artifactId}`, {
      type: CAPTION_REGIONS.jobType,
      bookId,
      sourceArtifactId: artifactId,
      mediaHash: source.mediaHash,
      transcriptHash: transcript.hash,
      componentKey: regionsComponentKey(source.mediaHash, transcript.hash),
    });
    await waitForBookJob(bookId, job.id, testBudget(30_000));
    const state = await analysisState(artifactId);
    expect(state.regions).toMatchObject({ status: "ready" });
    expect(state.regions?.value?.frames.map((frame) => frame.regions)).toEqual(times.map(() => [face]));
  });

  it("runs a queued legacy Alive analysis job as caption preparation", async () => {
    const artifactId = await speechVideo(TRANSCRIPT);
    await queue.enqueue(`alive-captions-${artifactId}-legacy`, { type: "analyze_alive_captions", assetId: artifactId, assetDir: "unused", bookId, force: false });
    await settled(artifactId, "vocal", "ready");
    expect(jobsOf(CAPTION_VOCAL.jobType, artifactId)).toHaveLength(1);
  });

  it("keeps the newest three results per component and artifact", async () => {
    const artifactId = await speechVideo(TRANSCRIPT);
    const keys = [1, 2, 3, 4].map((index) => analysisComponentKey(CAPTION_REGIONS, { sourceHash: `hash-${index}` }));
    for (const [index, key] of keys.entries()) {
      writeAnalysisComponent(engine, {
        component: CAPTION_REGIONS.component, key, artifactId, sourceHash: `hash-${index + 1}`,
        provenance: { analyzer: "test", version: 1, provider: null, model: null, createdAt: new Date().toISOString() },
        value: { frames: [] },
      });
    }
    expect(readAnalysisComponent(engine, CAPTION_REGIONS, keys[0], regionsValueSchema)).toBeNull();
    for (const key of keys.slice(1)) expect(readAnalysisComponent(engine, CAPTION_REGIONS, key, regionsValueSchema)).not.toBeNull();
  });
});
