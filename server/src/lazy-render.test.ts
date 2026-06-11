import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { VideocityFs } from "videocity-engine";
import { createFsForTest } from "./fs.js";
import { enqueueLazyTimelineRender } from "./lazy-render.js";
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

  it("enqueues assigned video renders with subtitles enabled by default", async () => {
    const enqueue = vi.spyOn(queue, "enqueue").mockResolvedValue(undefined);
    const assetId = await createVideoAsset();
    const timeline = await fs.writeProjectMeta("timeline", {
      slots: [{ slug: assetId }],
      render: "portrait",
    }, projectSlug);
    if (!timeline.ok) throw new Error(timeline.error.message);

    const result = await enqueueLazyTimelineRender(fs, projectSlug, assetId);

    expect(result?.jobId).toContain(`auto-render-${assetId}-portrait`);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const payload = enqueue.mock.calls[0][1];
    expect(payload.type).toBe("render_project");
    expect(payload.orientation).toBe("portrait");
    expect(payload.subtitlesEnabled).toBe(true);
    expect(payload.subtitleLanguage).toBe("original");
    expect(payload.fontSize).toBe("medium");
    expect(payload.strokeWidth).toBe(6);
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
