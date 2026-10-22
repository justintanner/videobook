import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import {
  clearRenderErrorIfPlayable,
  preservePlayableRenderSources,
  releaseQueuedRenderIfPlayable,
} from "./render-project.js";

describe("render source status", () => {
  let engine: Engine;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-render-source-"));
    engine = createEngineForTest(tempDir);
  });

  afterEach(async () => {
    closeEngineForTest(tempDir, engine);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function playableClip(): Promise<string> {
    const created = await engine.artifacts.create("vid", "clip");
    if (!created.ok) throw new Error(created.error.message);
    const assetId = created.value.artifactId;
    const written = await engine.files.write(assetId, "original.mp4", Buffer.from("fake-mp4"));
    if (!written.ok) throw new Error(written.error.message);
    const metadata = await engine.metadata.artifacts.write(assetId, "original", {
      duration: 20,
      width: 800,
      height: 1088,
    });
    if (!metadata.ok) throw new Error(metadata.error.message);
    return assetId;
  }

  async function viewStatus(assetId: string): Promise<string | undefined> {
    const view = engine.jobs.artifactWork.read(assetId);
    if (!view.ok) throw new Error(view.error.message);
    return view.value?.status;
  }

  async function publicStatus(assetId: string): Promise<string> {
    const status = await engine.status.get(assetId);
    if (!status.ok) throw new Error(status.error.message);
    return status.value;
  }

  function queueRender(assetId: string, orientation: "landscape" | "portrait" | "square"): void {
    engine.jobs.queue.enqueue({
      type: "render_project",
      artifactId: assetId,
      payload: { type: "render_project", assetId, orientation },
      artifactWorkKind: "render",
      artifactWorkOrientation: orientation,
      maxAttempts: 1,
      dedupeKey: `render-${orientation}-${assetId}`,
    });
  }

  it("restores a playable clip when lease expiry marked only the view", async () => {
    const assetId = await playableClip();
    queueRender(assetId, "landscape");
    const running = engine.jobs.queue.dequeue(process.pid, 60_000);
    expect(running).not.toBeNull();
    if (!running) return;
    expect(await engine.jobs.queue.fail(
      running.id,
      { error: { message: "Job lease expired" }, allowRetry: false },
      running.fence,
    )).toBe(true);
    expect(await viewStatus(assetId)).toBe("error");
    const premature = await engine.jobs.failures.clear(assetId);
    expect(premature.ok && premature.value).toBe(false);
    expect(await viewStatus(assetId)).toBe("error");

    expect(await clearRenderErrorIfPlayable(engine, assetId)).toBe(true);

    expect(await viewStatus(assetId)).toBe("ready");
    expect(await publicStatus(assetId)).toBe("ready");
    expect(engine.jobs.artifactWork.begin(assetId, {
      kind: "render",
      ownerKind: "job",
      durationMs: 5_000,
    })).not.toBeNull();
  });

  it("clears a generation error so the playable clip is ready again", async () => {
    const assetId = await playableClip();
    const written = await engine.jobs.failures.write(assetId, {
      message: "Asset is locked: workspace",
    });
    expect(written.ok).toBe(true);
    expect(await publicStatus(assetId)).toBe("error");

    expect(await clearRenderErrorIfPlayable(engine, assetId)).toBe(true);

    expect(await viewStatus(assetId)).toBe("ready");
    expect(await publicStatus(assetId)).toBe("ready");
  });

  it("leaves a source with no video in error", async () => {
    const created = await engine.artifacts.create("vid", "empty");
    if (!created.ok) throw new Error(created.error.message);
    const assetId = created.value.artifactId;
    const written = await engine.jobs.failures.write(assetId, { message: "render failed" });
    expect(written.ok).toBe(true);

    expect(await clearRenderErrorIfPlayable(engine, assetId)).toBe(false);
    expect(await publicStatus(assetId)).toBe("error");
  });

  it("drops a queued render view without disturbing an active orientation", async () => {
    const queued = await playableClip();
    queueRender(queued, "portrait");
    expect(await viewStatus(queued)).toBe("pending");
    expect(await publicStatus(queued)).toBe("render-queued-portrait");

    await releaseQueuedRenderIfPlayable(engine, queued);

    expect(await viewStatus(queued)).toBe("ready");
    expect(await publicStatus(queued)).toBe("ready");

    const active = await playableClip();
    const owner = engine.jobs.artifactWork.begin(active, {
      kind: "render",
      ownerKind: "job",
      durationMs: 60_000,
      meta: { orientation: "landscape" },
    });
    expect(owner).not.toBeNull();
    if (!owner) return;

    await releaseQueuedRenderIfPlayable(engine, active);

    const view = engine.jobs.artifactWork.read(active);
    expect(view.ok && view.value?.status).toBe("working");
    expect(view.ok ? view.value?.ownerId : null).toBe(owner.ownerId);
  });

  it("keeps a playable clip ready when the render fails before it claims", async () => {
    const assetId = await playableClip();
    const failed = await engine.jobs.failures.write(assetId, {
      message: "Asset is locked: workspace",
    });
    expect(failed.ok).toBe(true);
    queueRender(assetId, "square");
    expect(await publicStatus(assetId)).toBe("render-queued-square");
    const mark = vi.fn();

    let thrown: unknown;
    try {
      await preservePlayableRenderSources(
        engine,
        [assetId],
        mark,
        new Error("Remotion bundle failed"),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Remotion bundle failed");
    expect((thrown as { preserveArtifactState?: boolean }).preserveArtifactState).toBe(true);
    expect(mark).toHaveBeenCalledOnce();
    expect(await viewStatus(assetId)).toBe("ready");
    expect(await publicStatus(assetId)).toBe("ready");
  });

  it("does not roll back a source that has no playable video", async () => {
    const created = await engine.artifacts.create("vid", "empty");
    if (!created.ok) throw new Error(created.error.message);
    const assetId = created.value.artifactId;
    const written = await engine.jobs.failures.write(assetId, { message: "render failed" });
    expect(written.ok).toBe(true);
    const mark = vi.fn();

    let thrown: unknown;
    try {
      await preservePlayableRenderSources(
        engine,
        [assetId],
        mark,
        new Error("Remotion bundle failed"),
      );
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).message).toBe("Remotion bundle failed");
    expect((thrown as { preserveArtifactState?: boolean }).preserveArtifactState).toBeUndefined();
    expect(mark).not.toHaveBeenCalled();
    expect(await publicStatus(assetId)).toBe("error");
  });

  it("does not clear a playable clip another orientation is already rendering", async () => {
    const assetId = await playableClip();
    const owner = engine.jobs.artifactWork.begin(assetId, {
      kind: "render",
      ownerKind: "job",
      durationMs: 60_000,
      meta: { orientation: "landscape" },
    });
    expect(owner).not.toBeNull();
    if (!owner) return;
    const mark = vi.fn();

    await expect(preservePlayableRenderSources(
      engine,
      [assetId],
      mark,
      new Error("Asset is locked: workspace"),
    )).rejects.toThrow("Asset is locked: workspace");

    const view = engine.jobs.artifactWork.read(assetId);
    expect(view.ok && view.value?.status).toBe("working");
    expect(view.ok ? view.value?.ownerId : null).toBe(owner.ownerId);
    expect(mark).toHaveBeenCalledOnce();
  });
});
