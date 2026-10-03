import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { runFfmpeg } from "../ffmpeg.js";
import { queue, setEngineRoot } from "../queue.js";
import { buildAssetList } from "../tools/reconcile-project-work.js";
import { registerAllJobHandlers } from "./index.js";

function valueOf<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("missing video poster recovery", () => {
  let root: string;
  let engine: Engine;
  let videoPath: string;
  let bookId: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-poster-test-"));
    videoPath = join(root, "source.mp4");
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "color=black:s=160x90:r=10:d=0.2",
      "-f", "lavfi", "-i", "color=red:s=160x90:r=10:d=0.8",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath,
    ]);
    engine = createEngineForTest(root);
    bookId = engine.book.get().bookId;
    registerAllJobHandlers(engine);
    await setEngineRoot(root, engine);
  });

  afterAll(async () => {
    await queue.stop();
    if (engine) closeEngineForTest(root, engine);
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function createVideo(label: string) {
    const artifact = valueOf(await engine.artifacts.create({ kind: "video", label }));
    valueOf(await engine.files.writeFromPath(artifact.artifactId, "original.mp4", videoPath));
    valueOf(await engine.metadata.artifacts.write(artifact.artifactId, "original", {
      duration: 1, width: 160, height: 90, hasAudio: false,
    }));
    valueOf(await engine.metadata.waveforms.write(artifact.artifactId, []));
    const manifest = valueOf(await engine.files.manifest(artifact.artifactId));
    const source = manifest.files.find((file) => file.name === "original.mp4")!;
    return { artifact, source, manifest };
  }

  it("fills a missing poster on a later asset refresh and skips a black opening frame", async () => {
    const { artifact, source } = await createVideo("missing poster");
    const before = (await buildAssetList(engine, bookId)).find((asset) => asset.id === artifact.artifactId)!;
    expect(before).toMatchObject({ status: "ready", thumbnail_url: null });
    await expect.poll(async () => {
      const jobs = engine.jobs.queue.list({ type: "extract_video_poster" });
      return jobs.find((job) => job.payload.posterArtifactId === artifact.artifactId)?.state;
    }).toBe("done");
    const poster = valueOf(await engine.files.read(artifact.artifactId, "original.jpg"));
    const { data } = await sharp(poster).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200);
    expect(data[1]).toBeLessThan(30);
    expect(data[2]).toBeLessThan(30);
    const after = (await buildAssetList(engine, bookId)).find((asset) => asset.id === artifact.artifactId)!;
    expect(after.status).toBe("ready");
    expect(after.thumbnail_url).toContain(`/${artifact.artifactId}/original.jpg?v=`);
    expect(after.media_url).not.toBe(before.media_url);
    const manifest = valueOf(await engine.files.manifest(artifact.artifactId));
    expect(manifest.files.find((file) => file.name === "original.mp4")?.objectHash).toBe(source.objectHash);
    expect(engine.jobs.queue.list({ type: "extract_video_poster" })
      .filter((job) => job.payload.posterArtifactId === artifact.artifactId)).toHaveLength(1);
  });

  it("ignores a queued request for an older source and preserves an existing poster", async () => {
    const { artifact, source } = await createVideo("source guards");
    const payload = {
      type: "extract_video_poster", bookId, posterArtifactId: artifact.artifactId,
      sourceFilename: "original.mp4", sourceHash: "0".repeat(64),
    };
    expect(await queue.enqueueAndWait(`stale-poster-${artifact.artifactId}`, payload)).toEqual({ skipped: true });
    expect((await engine.files.read(artifact.artifactId, "original.jpg")).ok).toBe(false);
    const originalPoster = await sharp({ create: {
      width: 160, height: 90, channels: 3, background: "blue",
    } }).jpeg().toBuffer();
    valueOf(await engine.files.write(artifact.artifactId, "original.jpg", originalPoster));
    expect(await queue.enqueueAndWait(`existing-poster-${artifact.artifactId}`, {
      ...payload, sourceHash: source.objectHash,
    })).toEqual({ skipped: true });
    expect(valueOf(await engine.files.read(artifact.artifactId, "original.jpg"))).toEqual(originalPoster);
  });

  it("keeps a failed poster repair separate from the playable asset and dedupes refreshes", async () => {
    const { artifact } = await createVideo("bad source");
    valueOf(await engine.files.write(artifact.artifactId, "original.mp4", Buffer.from("invalid video")));
    await buildAssetList(engine, bookId);
    await expect.poll(() => engine.jobs.queue.list({ type: "extract_video_poster" })
      .find((job) => job.payload.posterArtifactId === artifact.artifactId)?.state).toBe("failed");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const asset = (await buildAssetList(engine, bookId)).find((entry) => entry.id === artifact.artifactId)!;
      expect(asset.status).toBe("ready");
    }
    expect(engine.jobs.queue.list({ type: "extract_video_poster" })
      .filter((job) => job.payload.posterArtifactId === artifact.artifactId)).toHaveLength(1);
    valueOf(await engine.files.writeFromPath(artifact.artifactId, "original.mp4", videoPath));
    await buildAssetList(engine, bookId);
    await expect.poll(async () => (await engine.files.read(artifact.artifactId, "original.jpg")).ok).toBe(true);
  });
});
