import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { VideocityFs } from "videobook-engine";
import { createFsForTest } from "./fs.js";
import { enqueueLazyAnalysisIfSlotted, enqueueLazyTimelineRender } from "./lazy-render.js";
import { queue } from "./queue.js";

describe("enqueueLazyTimelineRender", () => {
  let fs: VideocityFs;
  let tempDir: string;
  const projectSlug = "test-proj";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-lazy-render-test-"));
    fs = createFsForTest(tempDir);
    const project = await fs.createProject(projectSlug);
    if (!project.ok) throw new Error(project.error.message);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createVideoAsset(): Promise<string> {
    const created = await fs.createAsset("vid", "clip", projectSlug);
    if (!created.ok) throw new Error(created.error.message);
    const assetId = created.value.assetId;
    const writes = await Promise.all([
      fs.writeFile(assetId, "original.mp4", Buffer.from("fake-video"), projectSlug),
      fs.writeFile(assetId, ".original.analysis.json", Buffer.from(JSON.stringify({ burnedInSubtitles: null })), projectSlug),
      fs.writeFile(assetId, ".analysis.gpt4otrans.json", Buffer.from(JSON.stringify({ text: "real spoken words" })), projectSlug),
      fs.writeFile(assetId, "elevenlabs.json", Buffer.from(JSON.stringify({ words: [] })), projectSlug),
    ]);
    for (const write of writes) {
      if (!write.ok) throw new Error(write.error.message);
    }
    return assetId;
  }

  it("enqueues assigned video renders with clean audio and subtitles off by default", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createVideoAsset();
    const timeline = await fs.writeProjectMeta("timeline", {
      slots: [{ slug: assetId }],
      render: "portrait",
    }, projectSlug);
    if (!timeline.ok) throw new Error(timeline.error.message);

    const result = await enqueueLazyTimelineRender(fs, projectSlug, assetId);

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
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createVideoAsset();
    await fs.writeMetadata(assetId, "landscape.render", {
      subtitlesEnabled: true,
      audioVolume: 70,
      audioFadeIn: 200,
      audioFadeOut: 300,
    }, projectSlug);
    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: assetId }],
      render: "portrait",
    }, projectSlug);

    await enqueueLazyTimelineRender(fs, projectSlug, assetId);

    expect(enqueue).toHaveBeenCalledTimes(1);
    const payload = enqueue.mock.calls[0][1];
    expect(payload.subtitlesEnabled).toBe(true);
    expect(payload.audioVolume).toBe(70);
    expect(payload.audioFadeIn).toBe(200);
    expect(payload.audioFadeOut).toBe(300);
  });

  it("carries a stored subtitleLanguage through to the render payload", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createVideoAsset();
    // Settings live on another orientation: target-orientation metadata would
    // mark the clip already rendered, and readStoredRenderDefaults falls back.
    await fs.writeMetadata(assetId, "landscape.render", { subtitleLanguage: "en" }, projectSlug);
    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: assetId }],
      render: "portrait",
    }, projectSlug);

    await enqueueLazyTimelineRender(fs, projectSlug, assetId);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1].subtitleLanguage).toBe("en");
  });

  it("normalizes an invalid stored subtitleLanguage to 'original'", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createVideoAsset();
    await fs.writeMetadata(assetId, "landscape.render", { subtitleLanguage: "english!!" }, projectSlug);
    await fs.writeProjectMeta("timeline", {
      slots: [{ slug: assetId }],
      render: "portrait",
    }, projectSlug);

    await enqueueLazyTimelineRender(fs, projectSlug, assetId);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1].subtitleLanguage).toBe("original");
  });

  it("does not enqueue when the asset is not assigned to the timeline", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createVideoAsset();

    const result = await enqueueLazyTimelineRender(fs, projectSlug, assetId);

    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("enqueueLazyAnalysisIfSlotted", () => {
  let fs: VideocityFs;
  let tempDir: string;
  const projectSlug = "test-proj";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-lazy-analysis-test-"));
    fs = createFsForTest(tempDir);
    vi.stubEnv("KIE_API_KEY", "test-key");
    const project = await fs.createProject(projectSlug);
    if (!project.ok) throw new Error(project.error.message);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  // Mirrors the state a trim leaves behind: video re-processed (frames and
  // speech-to-text fresh) but the vision analysis sidecar deleted.
  async function createTrimmedVideoAsset(): Promise<string> {
    const created = await fs.createAsset("vid", "clip", projectSlug);
    if (!created.ok) throw new Error(created.error.message);
    const assetId = created.value.assetId;
    const writes = await Promise.all([
      fs.writeFile(assetId, "original.mp4", Buffer.from("fake-video"), projectSlug),
      fs.writeFile(assetId, ".analysis.gpt4otrans.json", Buffer.from(JSON.stringify({ text: "real spoken words" })), projectSlug),
    ]);
    for (const write of writes) {
      if (!write.ok) throw new Error(write.error.message);
    }
    return assetId;
  }

  async function assignToTimeline(assetId: string): Promise<void> {
    const timeline = await fs.writeProjectMeta("timeline", {
      slots: [{ slug: assetId }],
      render: "landscape",
    }, projectSlug);
    if (!timeline.ok) throw new Error(timeline.error.message);
  }

  it("enqueues analyze_video for a slotted video missing its analysis", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createTrimmedVideoAsset();
    await assignToTimeline(assetId);

    const result = await enqueueLazyAnalysisIfSlotted(fs, projectSlug, assetId);

    // Exact stable id shared with assign_slot's trigger: it doubles as the
    // queue dedupe key, so racing triggers collapse onto one analyze job.
    expect(result?.jobId).toBe(`auto-analyze-${assetId}`);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const payload = enqueue.mock.calls[0][1];
    expect(payload.type).toBe("analyze_video");
    expect(payload.assetId).toBe(assetId);
    expect(payload.projectSlug).toBe(projectSlug);
    expect(payload.hasTranscription).toBe(true);
  });

  it("does not enqueue when the analysis already exists", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createTrimmedVideoAsset();
    const written = await fs.writeFile(
      assetId, ".original.analysis.json",
      Buffer.from(JSON.stringify({ burnedInSubtitles: null })), projectSlug,
    );
    if (!written.ok) throw new Error(written.error.message);
    await assignToTimeline(assetId);

    const result = await enqueueLazyAnalysisIfSlotted(fs, projectSlug, assetId);

    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not enqueue when the asset is not assigned to the timeline", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createTrimmedVideoAsset();

    const result = await enqueueLazyAnalysisIfSlotted(fs, projectSlug, assetId);

    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not enqueue without a vision provider key", async () => {
    vi.stubEnv("KIE_API_KEY", "");
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createTrimmedVideoAsset();
    await assignToTimeline(assetId);

    const result = await enqueueLazyAnalysisIfSlotted(fs, projectSlug, assetId);

    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
