import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "videobook-engine";
import { clearDownloadFailure, DOWNLOAD_FAILURE_METADATA_KEY } from "./download-recovery.js";
import { closeEngineForTest, createEngineForTest } from "./engine.js";

describe("download recovery", () => {
  let root: string | undefined;
  let engine: Engine | undefined;

  afterEach(async () => {
    if (root && engine) closeEngineForTest(root, engine);
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 });
    root = undefined;
    engine = undefined;
  });

  async function failedDownload(): Promise<{ current: Engine; assetId: string }> {
    root = await mkdtemp(join(tmpdir(), "videobook-download-recovery-"));
    engine = createEngineForTest(root);
    const created = await engine.artifacts.create("video", "clip");
    if (!created.ok) throw new Error(created.error.message);
    const assetId = created.value.artifactId;
    await engine.metadata.artifacts.write(assetId, DOWNLOAD_FAILURE_METADATA_KEY, {
      reason: "unavailable",
      url: "http://127.0.0.1/clip.mp4",
      failedAt: new Date().toISOString(),
    });
    const failed = await engine.jobs.pending.forceFail(assetId, { message: "HTTP Error 404: Not Found" });
    if (!failed.ok) throw new Error(failed.error.message);
    return { current: engine, assetId };
  }

  it("clears the failure a download left once a retry or a chosen file brings the video", async () => {
    const { current, assetId } = await failedDownload();
    expect(current.jobs.failures.read(assetId)).toMatchObject({ ok: true, value: { message: "HTTP Error 404: Not Found" } });

    await clearDownloadFailure(current, assetId);

    expect(current.jobs.failures.read(assetId)).toEqual({ ok: true, value: null });
    expect((await current.metadata.artifacts.read(assetId, DOWNLOAD_FAILURE_METADATA_KEY)).ok).toBe(false);
    const work = current.jobs.artifactWork.read(assetId);
    expect(work.ok && work.value?.status).not.toBe("error");
  });

  it("leaves an asset with no recorded failure alone", async () => {
    const { current, assetId } = await failedDownload();
    await clearDownloadFailure(current, assetId);
    await expect(clearDownloadFailure(current, assetId)).resolves.toBeUndefined();
    expect(current.jobs.failures.read(assetId)).toEqual({ ok: true, value: null });
  });
});
