import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "./engine.js";
import { enqueueLazyAnalysisIfSlotted, enqueueLazyTimelineRender } from "./lazy-render.js";
import { queue } from "./queue.js";
import { writeTimeline, type TimelineRender } from "./timeline-helpers.js";

async function registerTestVideoStream(
  fs: Engine,
  artifactId: string,
): Promise<void> {
  const manifest = await fs.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = manifest.value.files.find((entry) => entry.name === "original.mp4");
  if (!file) throw new Error("Missing original.mp4");
  const registered = await fs.streams.register({
    artifactId,
    sourcePath: file.name,
    objectHash: file.objectHash,
    streamIndex: 0,
    kind: "video",
    timeBase: { numerator: 1, denominator: 1_000 },
    durationTicks: 12_000,
    codec: "h264",
    video: {
      width: 1920,
      height: 1080,
      rotationDegrees: 0,
      pixelAspect: { numerator: 1, denominator: 1 },
      nominalFrameRate: { numerator: 30, denominator: 1 },
    },
  });
  if (!registered.ok) throw new Error(registered.error.message);
}

async function setTimelineSlot(
  fs: Engine,
  assetId: string,
  render: TimelineRender,
): Promise<void> {
  const asset = fs.artifacts.get(assetId);
  if (!asset.ok) throw new Error(asset.error.message);
  const timeline = await writeTimeline(fs, {
    render,
    slots: [{ artifactId: asset.value.artifactId }],
  });
  if (!timeline.ok) throw new Error(timeline.error.message);
}

describe("enqueueLazyTimelineRender", () => {
  let fs: Engine;
  let tempDir: string;
  let bookId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-lazy-render-test-"));
    fs = createEngineForTest(tempDir);
    bookId = fs.book.get().bookId;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeEngineForTest(tempDir, fs);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createVideoAsset(): Promise<string> {
    const created = await fs.artifacts.create("vid", "clip");
    if (!created.ok) throw new Error(created.error.message);
    const assetId = created.value.artifactId;
    for (const [filename, contents] of [
      ["original.mp4", Buffer.from("fake-video")],
      [".original.analysis.json", Buffer.from(JSON.stringify({ burnedInSubtitles: null }))],
      [".analysis.gpt4otrans.json", Buffer.from(JSON.stringify({ text: "real spoken words" }))],
      ["elevenlabs.json", Buffer.from(JSON.stringify({ words: [] }))],
    ] as const) {
      const write = await fs.files.write(assetId, filename, contents);
      if (!write.ok) throw new Error(write.error.message);
    }
    await registerTestVideoStream(fs, created.value.artifactId);
    return assetId;
  }

  it("enqueues assigned video renders with clean audio and subtitles off by default", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue({
      id: 1,
      operationId: "test-job",
      type: "render_project",
      artifactId: null,
      externalTaskId: null,
      state: "queued",
      payload: {},
      result: null,
      attempts: 0,
      maxAttempts: 1,
      error: null,
      enqueuedAt: 0,
      startedAt: null,
      finishedAt: null,
      leaseExpiresAt: null,
      fence: 0,
    });
    const assetId = await createVideoAsset();
    await setTimelineSlot(fs, assetId, "portrait");

    const result = await enqueueLazyTimelineRender(fs, bookId, assetId);

    // Exact stable id: it doubles as the queue dedupe key, so racing
    // triggers collapse onto one render job.
    expect(result?.jobId).toBe(`auto-render-${assetId}-portrait`);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const payload = enqueue.mock.calls[0][1];
    expect(payload.type).toBe("render_project");
    expect(payload.orientation).toBe("portrait");
    expect(payload.subtitlesEnabled).toBe(false);
    expect(payload.subtitleLanguage).toBe("original");
    expect(payload.fontSize).toBe("medium");
    expect(payload.audioVolume).toBe(100);
    expect(payload.audioFadeIn).toBe(0);
    expect(payload.audioFadeOut).toBe(0);
    expect(payload.strokeWidth).toBe(6);
  });

  it("carries stored subtitle and audio overrides through to the render payload", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue({
      id: 1,
      operationId: "test-job",
      type: "render_project",
      artifactId: null,
      externalTaskId: null,
      state: "queued",
      payload: {},
      result: null,
      attempts: 0,
      maxAttempts: 1,
      error: null,
      enqueuedAt: 0,
      startedAt: null,
      finishedAt: null,
      leaseExpiresAt: null,
      fence: 0,
    });
    const assetId = await createVideoAsset();
    await fs.metadata.artifacts.write(assetId, "landscape.render", {
      subtitlesEnabled: true,
      audioVolume: 70,
      audioFadeIn: 200,
      audioFadeOut: 300,
    });
    await setTimelineSlot(fs, assetId, "portrait");

    await enqueueLazyTimelineRender(fs, bookId, assetId);

    expect(enqueue).toHaveBeenCalledTimes(1);
    const payload = enqueue.mock.calls[0][1];
    expect(payload.subtitlesEnabled).toBe(true);
    expect(payload.audioVolume).toBe(70);
    expect(payload.audioFadeIn).toBe(200);
    expect(payload.audioFadeOut).toBe(300);
  });

  it("carries stored watermark OSG settings through to the render payload", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue({
      id: 1,
      operationId: "test-job",
      type: "render_project",
      artifactId: null,
      externalTaskId: null,
      state: "queued",
      payload: {},
      result: null,
      attempts: 0,
      maxAttempts: 1,
      error: null,
      enqueuedAt: 0,
      startedAt: null,
      finishedAt: null,
      leaseExpiresAt: null,
      fence: 0,
    });
    const assetId = await createVideoAsset();
    await fs.metadata.artifacts.write(assetId, "portrait.render", {
      osgAssetId: "img-badge",
      osgPosition: "bottom-left",
      osgSize: "medium",
      osgScale: 1.1429,
      osgOpacity: 0.5,
      osgTailSeconds: null,
    });
    await setTimelineSlot(fs, assetId, "portrait");

    await enqueueLazyTimelineRender(fs, bookId, assetId);

    expect(enqueue).toHaveBeenCalledTimes(1);
    const payload = enqueue.mock.calls[0][1];
    expect(payload.osgAssetId).toBe("img-badge");
    expect(payload.osgPosition).toBe("bottom-left");
    expect(payload.osgScale).toBe(1.1429);
    expect(payload.osgOpacity).toBe(0.5);
  });

  it("carries a stored subtitleLanguage through to the render payload", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue({
      id: 1,
      operationId: "test-job",
      type: "render_project",
      artifactId: null,
      externalTaskId: null,
      state: "queued",
      payload: {},
      result: null,
      attempts: 0,
      maxAttempts: 1,
      error: null,
      enqueuedAt: 0,
      startedAt: null,
      finishedAt: null,
      leaseExpiresAt: null,
      fence: 0,
    });
    const assetId = await createVideoAsset();
    // Settings live on another orientation: target-orientation metadata would
    // mark the clip already rendered, and readStoredRenderDefaults falls back.
    await fs.metadata.artifacts.write(assetId, "landscape.render", { subtitleLanguage: "en" });
    await setTimelineSlot(fs, assetId, "portrait");

    await enqueueLazyTimelineRender(fs, bookId, assetId);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1].subtitleLanguage).toBe("en");
  });

  it("normalizes an invalid stored subtitleLanguage to 'original'", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue({
      id: 1,
      operationId: "test-job",
      type: "render_project",
      artifactId: null,
      externalTaskId: null,
      state: "queued",
      payload: {},
      result: null,
      attempts: 0,
      maxAttempts: 1,
      error: null,
      enqueuedAt: 0,
      startedAt: null,
      finishedAt: null,
      leaseExpiresAt: null,
      fence: 0,
    });
    const assetId = await createVideoAsset();
    await fs.metadata.artifacts.write(assetId, "landscape.render", { subtitleLanguage: "english!!" });
    await setTimelineSlot(fs, assetId, "portrait");

    await enqueueLazyTimelineRender(fs, bookId, assetId);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1].subtitleLanguage).toBe("original");
  });

  it("does not enqueue when the asset is not assigned to the timeline", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue({
      id: 1,
      operationId: "test-job",
      type: "render_project",
      artifactId: null,
      externalTaskId: null,
      state: "queued",
      payload: {},
      result: null,
      attempts: 0,
      maxAttempts: 1,
      error: null,
      enqueuedAt: 0,
      startedAt: null,
      finishedAt: null,
      leaseExpiresAt: null,
      fence: 0,
    });
    const assetId = await createVideoAsset();

    const result = await enqueueLazyTimelineRender(fs, bookId, assetId);

    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("enqueueLazyAnalysisIfSlotted", () => {
  let fs: Engine;
  let tempDir: string;
  let bookId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-lazy-analysis-test-"));
    fs = createEngineForTest(tempDir);
    bookId = fs.book.get().bookId;
    vi.stubEnv("OPENAI_API_KEY", "test-key");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    closeEngineForTest(tempDir, fs);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  // Mirrors the state a trim leaves behind: video re-processed (frames and
  // speech-to-text fresh) but the vision analysis sidecar deleted.
  async function createTrimmedVideoAsset(): Promise<string> {
    const created = await fs.artifacts.create("vid", "clip");
    if (!created.ok) throw new Error(created.error.message);
    const assetId = created.value.artifactId;
    for (const [filename, contents] of [
      ["original.mp4", Buffer.from("fake-video")],
      [".analysis.gpt4otrans.json", Buffer.from(JSON.stringify({ text: "real spoken words" }))],
    ] as const) {
      const write = await fs.files.write(assetId, filename, contents);
      if (!write.ok) throw new Error(write.error.message);
    }
    await registerTestVideoStream(fs, created.value.artifactId);
    return assetId;
  }

  async function assignToTimeline(assetId: string): Promise<void> {
    await setTimelineSlot(fs, assetId, "landscape");
  }

  it("enqueues analyze_video for a slotted video missing its analysis", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue({
      id: 1,
      operationId: "test-job",
      type: "render_project",
      artifactId: null,
      externalTaskId: null,
      state: "queued",
      payload: {},
      result: null,
      attempts: 0,
      maxAttempts: 1,
      error: null,
      enqueuedAt: 0,
      startedAt: null,
      finishedAt: null,
      leaseExpiresAt: null,
      fence: 0,
    });
    const assetId = await createTrimmedVideoAsset();
    await assignToTimeline(assetId);

    const result = await enqueueLazyAnalysisIfSlotted(fs, bookId, assetId);

    // Exact stable id shared with assign_slot's trigger: it doubles as the
    // queue dedupe key, so racing triggers collapse onto one analyze job.
    expect(result?.jobId).toBe(`auto-analyze-${assetId}`);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const payload = enqueue.mock.calls[0][1];
    expect(payload.type).toBe("analyze_video");
    expect(payload.assetId).toBe(assetId);
    expect(payload.bookId).toBe(bookId);
    expect(payload.hasTranscription).toBe(true);
  });

  it("does not enqueue when the analysis already exists", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue({
      id: 1,
      operationId: "test-job",
      type: "render_project",
      artifactId: null,
      externalTaskId: null,
      state: "queued",
      payload: {},
      result: null,
      attempts: 0,
      maxAttempts: 1,
      error: null,
      enqueuedAt: 0,
      startedAt: null,
      finishedAt: null,
      leaseExpiresAt: null,
      fence: 0,
    });
    const assetId = await createTrimmedVideoAsset();
    const written = await fs.files.write(assetId, ".original.analysis.json", Buffer.from(JSON.stringify({ burnedInSubtitles: null }))
    );
    if (!written.ok) throw new Error(written.error.message);
    await assignToTimeline(assetId);

    const result = await enqueueLazyAnalysisIfSlotted(fs, bookId, assetId);

    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not enqueue when the asset is not assigned to the timeline", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue({
      id: 1,
      operationId: "test-job",
      type: "render_project",
      artifactId: null,
      externalTaskId: null,
      state: "queued",
      payload: {},
      result: null,
      attempts: 0,
      maxAttempts: 1,
      error: null,
      enqueuedAt: 0,
      startedAt: null,
      finishedAt: null,
      leaseExpiresAt: null,
      fence: 0,
    });
    const assetId = await createTrimmedVideoAsset();

    const result = await enqueueLazyAnalysisIfSlotted(fs, bookId, assetId);

    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not enqueue without a vision provider key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue({
      id: 1,
      operationId: "test-job",
      type: "render_project",
      artifactId: null,
      externalTaskId: null,
      state: "queued",
      payload: {},
      result: null,
      attempts: 0,
      maxAttempts: 1,
      error: null,
      enqueuedAt: 0,
      startedAt: null,
      finishedAt: null,
      leaseExpiresAt: null,
      fence: 0,
    });
    const assetId = await createTrimmedVideoAsset();
    await assignToTimeline(assetId);

    const result = await enqueueLazyAnalysisIfSlotted(fs, bookId, assetId);

    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
