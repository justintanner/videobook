import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsP from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createServer, type Server } from "node:http";
import {
  queue as appQueue,
  registerJobHandler,
  setEngineRoot,
} from "../queue.js";
import {
  completionFamilyForTaskType,
  registerCompleteProviderTaskJob,
} from "./complete-provider-task.js";
import { registerProcessImageJob } from "./process-image.js";

// 1x1 PNG
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

describe("provider completion routing", () => {
  it.each([
    ["media_kie", "media"],
    ["fal_media", "media"],
    ["xai_media", "media"],
    ["media_googleflow", "media"],
    ["isolate_vocals", "isolateVocals"],
    ["seedance2_video", "media"],
    ["kling30_video", "media"],
    ["nano_banana_image", "media"],
    ["fal_kling_v3_pro_i2v", "media"],
    ["xai_grok_imagine_video", "media"],
    ["alibaba_image", "media"],
  ])("routes %s to %s", (taskType, family) => {
    expect(completionFamilyForTaskType(taskType)).toBe(family);
  });

  it("rejects task types without a completion family", () => {
    expect(completionFamilyForTaskType("unknown_provider_task")).toBeUndefined();
  });
});

describe("complete_kie_task media generations", () => {
  let projectsDir: string;
  let imageServer: Server;
  let imageUrl: string;
  let testEngine: ReturnType<typeof createEngineForTest> | undefined;

  beforeEach(async () => {
    projectsDir = await fsP.mkdtemp(path.join(os.tmpdir(), "vc-complete-qwen-"));

    imageServer = createServer((req, res) => {
      if (req.url?.includes("/missing/")) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": TINY_PNG.length });
      res.end(TINY_PNG);
    });
    await new Promise<void>((resolve) => {
      imageServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = imageServer.address();
    if (!addr || typeof addr === "string") throw new Error("no listen address");
    imageUrl = `http://127.0.0.1:${addr.port}/image.png`;
  });

  afterEach(async () => {
    await appQueue.stop();
    if (testEngine) {
      closeEngineForTest(projectsDir, testEngine);
      testEngine = undefined;
    }
    await new Promise<void>((resolve, reject) => {
      imageServer.close((err) => (err ? reject(err) : resolve()));
    });
    await fsP.rm(projectsDir, { recursive: true, force: true });
  });

  async function seedPendingTask(
    taskType: string,
    assetType = "img",
    media = assetType === "video" ? "video" : "image",
  ): Promise<{ assetId: string; assetDir: string; taskId: string; bookId: string; fs: ReturnType<typeof createEngineForTest> }> {
    const cfs = createEngineForTest(projectsDir);
    testEngine = cfs;
    await setEngineRoot(projectsDir, cfs);
    const bookId = cfs.book.get().bookId;
    const asset = await cfs.artifacts.create(assetType, "provider-output");
    expect(asset.ok).toBe(true);
    if (!asset.ok) throw new Error(asset.error.message);

    const lease = await cfs.jobs.artifactWork.begin(asset.value.artifactId, {
      kind: "generate",
      ownerKind: "job",
      durationMs: 60_000,
    });
    if (!lease) throw new Error("assetWork.begin failed");

    const taskId = `provider-task-${taskType}`;
    const written = await cfs.jobs.pending.write({
        artifactId: asset.value.artifactId,
        taskId,
        taskType,
        meta: { prompt: "a cat", sourceImageIds: [], media, model: "kie:nano-banana-2-1" },
      }, lease.ownerId
    );
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error(written.error.message);

    return {
      assetId: asset.value.artifactId,
      assetDir: asset.value.path,
      taskId,
      bookId,
      fs: cfs,
    };
  }

  function readOriginal(engine: ReturnType<typeof createEngineForTest>, assetId: string, filename: string) {
    return engine.files.read(assetId, filename);
  }

  it("records the catalog model and prompt as image provenance", async () => {
    const { assetId, assetDir, taskId, bookId, fs: engine } = await seedPendingTask("media_kie");
    registerCompleteProviderTaskJob(engine);
    registerProcessImageJob(engine);
    await appQueue.enqueueAndWait(`complete-media-${assetId}`, {
      type: "complete_kie_task",
      taskId, taskType: "media_kie", assetId, assetDir, bookId,
      meta: { prompt: "a cat", sourceImageIds: [], media: "image", model: "kie:gpt-image-2-5-sunburst-text-to-image" },
      resultUrls: [imageUrl],
    }, 10_000);
    await expect.poll(async () => {
      const result = await engine.metadata.artifacts.read<Record<string, unknown>>(assetId, "original");
      return result.ok ? result.value : null;
    }, { timeout: 10_000 }).toMatchObject({
      model: "kie:gpt-image-2-5-sunburst-text-to-image", prompt: "a cat", width: 1, height: 1, download_url: imageUrl,
    });
  });

  it.each([
    ["images", { images: [{ url: "IMAGE" }] }],
    ["image.url", { image: { url: "IMAGE" } }],
  ] as const)("downloads a fal result published as %s", async (_label, shape) => {
    const { assetId, assetDir, taskId, bookId, fs: cfs } = await seedPendingTask("fal_media");
    registerCompleteProviderTaskJob(cfs);
    registerJobHandler("process_image", async () => ({ ok: true }));
    const resultObject = JSON.parse(JSON.stringify(shape).replace("IMAGE", imageUrl)) as Record<string, unknown>;
    const result = await appQueue.enqueueAndWait<{ success: boolean }>(`complete-fal-${assetId}`, {
      type: "complete_kie_task",
      taskId, taskType: "fal_media", assetId, assetDir, bookId,
      meta: { prompt: "a dog", sourceImageIds: [], media: "image", model: "fal:fal-ai/qwen-image" },
      resultUrls: [],
      resultObject,
    }, 10_000);
    expect(result.success).toBe(true);
    const original = await readOriginal(cfs, assetId, "original.png");
    expect(original.ok).toBe(true);
    if (original.ok) expect(Buffer.from(original.value).equals(TINY_PNG)).toBe(true);
    const pending = await cfs.jobs.pending.read(assetId);
    expect(pending.ok ? pending.value : "fail").toBeNull();
  });

  it("fails when the provider result has no media URL (no silent ready)", async () => {
    const { assetId, assetDir, taskId, bookId, fs: cfs } = await seedPendingTask("fal_media");
    registerCompleteProviderTaskJob(cfs);
    await expect(appQueue.enqueueAndWait(`complete-empty-${assetId}`, {
      type: "complete_kie_task",
      taskId, taskType: "fal_media", assetId, assetDir, bookId,
      meta: { prompt: "a cat", sourceImageIds: [], media: "image", model: "fal:fal-ai/qwen-image" },
      resultUrls: [],
      resultObject: { images: [] },
    }, 10_000)).rejects.toThrow(/Provider returned no image/i);
    const original = await readOriginal(cfs, assetId, "original.png");
    expect(original.ok).toBe(false);
  });

  it("writes a generated video and hands it to process_video", async () => {
    const { assetId, assetDir, taskId, bookId, fs: cfs } = await seedPendingTask("media_kie", "video");
    registerCompleteProviderTaskJob(cfs);
    const processed: Array<Record<string, unknown>> = [];
    registerJobHandler("process_video", async (payload) => {
      processed.push(payload);
      return { ok: true };
    });
    const result = await appQueue.enqueueAndWait<{ success: boolean }>(`complete-video-${assetId}`, {
      type: "complete_kie_task",
      taskId, taskType: "media_kie", assetId, assetDir, bookId,
      meta: { prompt: "waves", media: "video", model: "kie:bytedance/seedance-2-5" },
      resultUrls: [imageUrl.replace("image.png", "clip.mp4")],
    }, 10_000);
    expect(result.success).toBe(true);
    const original = await readOriginal(cfs, assetId, "original.mp4");
    expect(original.ok).toBe(true);
    await expect.poll(() => processed.length, { timeout: 10_000 }).toBe(1);
    expect(processed[0]).toMatchObject({ assetId, provenance: { model: "kie:bytedance/seedance-2-5", prompt: "waves" } });
  });

  it("completes a task recorded by a retired per-model job as media", async () => {
    const { assetId, assetDir, taskId, bookId, fs: cfs } = await seedPendingTask("seedance2_video", "video");
    registerCompleteProviderTaskJob(cfs);
    const processed: Array<Record<string, unknown>> = [];
    registerJobHandler("process_video", async (payload) => {
      processed.push(payload);
      return { ok: true };
    });
    const result = await appQueue.enqueueAndWait<{ success: boolean }>(`complete-legacy-${assetId}`, {
      type: "complete_kie_task",
      taskId, taskType: "seedance2_video", assetId, assetDir, bookId,
      meta: {
        apiModel: "bytedance/seedance-2-5",
        mode: "frames",
        output_format: "mp4",
        prompt: "the eyes come to life",
        sourceImageIds: ["img-first", "img-last"],
        sourceVideoIds: [],
        sourceAudioIds: [],
      },
      resultUrls: [imageUrl.replace("image.png", "clip.mp4")],
    }, 10_000);
    expect(result.success).toBe(true);
    expect((await readOriginal(cfs, assetId, "original.mp4")).ok).toBe(true);
    await expect.poll(() => processed.length, { timeout: 10_000 }).toBe(1);
    expect(processed[0]).toMatchObject({
      assetId,
      provenance: {
        model: "bytedance/seedance-2-5",
        prompt: "the eyes come to life",
        source_images: ["img-first", "img-last"],
      },
    });
    const pending = await cfs.jobs.pending.read(assetId);
    expect(pending.ok ? pending.value : "fail").toBeNull();
  });

  it("re-claims a failed completion when the same payload is retried", async () => {
    const { assetId, assetDir, taskId, bookId, fs: cfs } = await seedPendingTask("media_kie", "video");
    registerCompleteProviderTaskJob(cfs);
    const processed: Array<Record<string, unknown>> = [];
    registerJobHandler("process_video", async (payload) => {
      processed.push(payload);
      return { ok: true };
    });
    const payload = {
      type: "complete_kie_task",
      taskId, taskType: "media_kie", assetId, assetDir, bookId,
      meta: { prompt: "waves", media: "video", model: "kie:bytedance/seedance-2-5" },
      resultUrls: [imageUrl.replace("image.png", "missing/clip.mp4")],
    };
    await expect(appQueue.enqueueAndWait(`complete-first-${assetId}`, payload, 10_000))
      .rejects.toThrow(/Failed to download generated video: 404/);
    const failed = cfs.jobs.failures.read(assetId);
    expect(failed.ok ? failed.value?.message : "fail").toMatch(/404/);
    expect((await cfs.jobs.pending.read(assetId)).ok).toBe(true);

    const retried = await appQueue.enqueueAndWait<Record<string, unknown>>(`retry-complete_kie_task-${assetId}`, {
      ...payload,
      resultUrls: [imageUrl.replace("image.png", "clip.mp4")],
    }, 10_000);
    expect(retried).toEqual({ success: true });
    expect((await readOriginal(cfs, assetId, "original.mp4")).ok).toBe(true);
    const cleared = cfs.jobs.failures.read(assetId);
    expect(cleared.ok ? cleared.value : "fail").toBeNull();
    const work = cfs.jobs.artifactWork.read(assetId);
    expect(work.ok ? work.value?.status : "fail").not.toBe("error");
    const pendingAfter = await cfs.jobs.pending.read(assetId);
    expect(pendingAfter.ok ? pendingAfter.value : "fail").toBeNull();
    await expect.poll(() => processed.length, { timeout: 10_000 }).toBe(1);
  });

  it("fails an unknown provider task instead of silently completing it", async () => {
    const taskType = "unknown_provider_task";
    const { assetId, assetDir, taskId, bookId, fs: cfs } = await seedPendingTask(taskType);
    registerCompleteProviderTaskJob(cfs);

    await expect(
      appQueue.enqueueAndWait(
        `complete-unknown-${assetId}`,
        {
          type: "complete_kie_task",
          taskId,
          taskType,
          assetId,
          assetDir,
          bookId,
          meta: {},
          resultUrls: [],
        },
        10_000,
      ),
    ).rejects.toThrow(/Unhandled provider task type: unknown_provider_task/);

    const pending = await cfs.jobs.pending.read(assetId);
    expect(pending.ok).toBe(true);
    if (pending.ok) {
      expect(pending.value).toBeNull();
    }
    const failure = await cfs.jobs.failures.read(assetId);
    expect(failure.ok).toBe(true);
    if (failure.ok) {
      expect(failure.value?.message).toMatch(/Unhandled provider task type/);
    }
  });
});
