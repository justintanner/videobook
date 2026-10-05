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
    ["nano_banana_image", "nanoBananaImage"],
    ["fal_nano_banana_2_edit", "nanoBananaImage"],
    ["qwen2_image_edit", "qwenImage"],
    ["fal_qwen_image", "qwenImage"],
    ["seedream_image", "seedreamImage"],
    ["fal_seedream_v5_lite_edit", "seedreamV5Image"],
    ["fal_bria_fibo_edit_1_5_product_holding", "seedreamV5Image"],
    ["fal_bria_fibo_edit_1_5_virtual_try_on", "seedreamV5Image"],
    ["kling30_motion_control_video", "klingVideo"],
    ["kling30_omni_video", "providerVideo"],
    ["seedance2_video", "providerVideo"],
    ["fal_wan27_videoedit", "providerVideo"],
    ["fal_grok_imagine_video_extend", "providerVideo"],
    ["grok_imagine_upscale_video", "grokVideo"],
    ["wan27_extend_video", "wanVideo"],
    ["happyhorse_ref_video", "happyHorseVideo"],
    ["minimax_h3_i2v_video", "miniMaxVideo"],
    ["volcengine_lipsync_video", "lipSyncVideo"],
    ["omnihuman_video", "omnihumanVideo"],
    ["fal_wan27_pro_edit", "wanImage"],
    ["alibaba_video", "alibabaVideo"],
    ["alibaba_image_pro", "alibabaImage"],
    ["alibaba_qwen_image_edit", "alibabaQwenImage"],
    ["fal_grok_imagine_image_edit", "grokImage"],
    ["gpt_image_text", "gptImage"],
    ["isolate_vocals", "isolateVocals"],
  ])("routes %s to %s", (taskType, family) => {
    expect(completionFamilyForTaskType(taskType)).toBe(family);
  });

  it("rejects task types without a completion family", () => {
    expect(completionFamilyForTaskType("unknown_provider_task")).toBeUndefined();
  });
});

describe("complete_kie_task fal_qwen branches", () => {
  let projectsDir: string;
  let imageServer: Server;
  let imageUrl: string;
  let testEngine: ReturnType<typeof createEngineForTest> | undefined;

  beforeEach(async () => {
    projectsDir = await fsP.mkdtemp(path.join(os.tmpdir(), "vc-complete-qwen-"));

    imageServer = createServer((_req, res) => {
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
        meta: { prompt: "a cat", sourceImageIds: [] },
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

  it.each([
    ["gpt_image", "gpt-image-2-5-sunburst-image-to-image"],
    ["gpt_image_text", "gpt-image-2-5-flare-text-to-image"],
    ["gpt_image", undefined],
    ["gpt_image_text", undefined],
  ] as const)("preserves completed GPT provenance for %s / %s", async (taskType, model) => {
    const { assetId, assetDir, taskId, bookId, fs: engine } = await seedPendingTask(taskType);
    registerCompleteProviderTaskJob(engine);
    registerProcessImageJob(engine);
    await appQueue.enqueueAndWait(`complete-gpt-${assetId}`, {
      type: "complete_kie_task",
      taskId, taskType, assetId, assetDir, bookId,
      meta: {
        prompt: "a cat", sourceImageIds: [],
        ...(model ? { model, resolution: "2K", background: "transparent" } : {}),
      },
      resultUrls: [imageUrl],
    }, 10_000);

    const expectedModel = model ?? (taskType === "gpt_image" ? "gpt-image-2-image-to-image" : "gpt-image-2-text-to-image");
    await expect.poll(async () => {
      const result = await engine.metadata.artifacts.read<Record<string, unknown>>(assetId, "original");
      return result.ok ? result.value : null;
    }, { timeout: 10_000 }).toMatchObject({
      model: expectedModel, prompt: "a cat", width: 1, height: 1,
      ...(model ? { resolution: "2K", background: "transparent" } : {}),
    });
  });

  it("downloads fal_qwen_image_edit result instead of marking ready empty", async () => {
    const { assetId, assetDir, taskId, bookId, fs: cfs } = await seedPendingTask("fal_qwen_image_edit");
    registerCompleteProviderTaskJob(cfs);
    // Swallow process_image follow-up so the completion path alone is under test.
    registerJobHandler("process_image", async () => ({ ok: true }));

    const result = await appQueue.enqueueAndWait<{ success: boolean }>(
      `complete-qwen-edit-${assetId}`,
      {
        type: "complete_kie_task",
        taskId,
        taskType: "fal_qwen_image_edit",
        assetId,
        assetDir,
        bookId,
        meta: { prompt: "a cat", sourceImageIds: [] },
        resultUrls: [],
        resultObject: { images: [{ url: imageUrl }] },
      },
      10_000,
    );

    expect(result.success).toBe(true);

    const original = await cfs.files.read(assetId, "original.png");
    expect(original.ok).toBe(true);
    if (original.ok) {
      const buf = typeof original.value === "string"
        ? Buffer.from(original.value)
        : Buffer.from(original.value);
      expect(buf.equals(TINY_PNG)).toBe(true);
    }

    const pending = await cfs.jobs.pending.read(assetId);
    expect(pending.ok).toBe(true);
    expect(pending.ok ? pending.value : "fail").toBeNull();
  });

  it("downloads fal_qwen_image (T2I) result", async () => {
    const { assetId, assetDir, taskId, bookId, fs: cfs } = await seedPendingTask("fal_qwen_image");
    registerCompleteProviderTaskJob(cfs);
    registerJobHandler("process_image", async () => ({ ok: true }));

    const result = await appQueue.enqueueAndWait<{ success: boolean }>(
      `complete-qwen-t2i-${assetId}`,
      {
        type: "complete_kie_task",
        taskId,
        taskType: "fal_qwen_image",
        assetId,
        assetDir,
        bookId,
        meta: { prompt: "a dog", sourceImageIds: [] },
        resultUrls: [],
        resultObject: { images: [{ url: imageUrl }] },
      },
      10_000,
    );

    expect(result.success).toBe(true);

    const original = await cfs.files.read(assetId, "original.png");
    expect(original.ok).toBe(true);
  });

  it.each([
    "fal_bria_fibo_edit_1_5_product_holding",
    "fal_bria_fibo_edit_1_5_virtual_try_on",
  ])("downloads %s when the result publishes image.url and omits images", async (taskType) => {
    const { assetId, assetDir, taskId, bookId, fs: cfs } = await seedPendingTask(taskType);
    registerCompleteProviderTaskJob(cfs);
    registerJobHandler("process_image", async () => ({ ok: true }));

    const result = await appQueue.enqueueAndWait<{ success: boolean }>(
      `complete-fibo-${assetId}`,
      {
        type: "complete_kie_task",
        taskId,
        taskType,
        assetId,
        assetDir,
        bookId,
        meta: { prompt: "hold the product", sourceImageIds: [], model: "bria/fibo-edit-1.5" },
        resultUrls: [],
        resultObject: { image: { url: imageUrl } },
      },
      10_000,
    );

    expect(result.success).toBe(true);
    const original = await cfs.files.read(assetId, "original.png");
    expect(original.ok).toBe(true);
    if (original.ok) {
      const buf = typeof original.value === "string"
        ? Buffer.from(original.value)
        : Buffer.from(original.value);
      expect(buf.equals(TINY_PNG)).toBe(true);
    }
    const pending = await cfs.jobs.pending.read(assetId);
    expect(pending.ok).toBe(true);
    expect(pending.ok ? pending.value : "fail").toBeNull();
  });

  it("fails when fal_qwen result has no image URLs (no silent ready)", async () => {
    const { assetId, assetDir, taskId, bookId, fs: cfs } = await seedPendingTask("fal_qwen_image_edit");
    registerCompleteProviderTaskJob(cfs);

    await expect(
      appQueue.enqueueAndWait(
        `complete-qwen-empty-${assetId}`,
        {
          type: "complete_kie_task",
          taskId,
          taskType: "fal_qwen_image_edit",
          assetId,
          assetDir,
          bookId,
          meta: { prompt: "a cat", sourceImageIds: [] },
          resultUrls: [],
          resultObject: { images: [] },
        },
        10_000,
      ),
    ).rejects.toThrow(/No image URL in result/i);

    // Regression: prior bug deleted the pending task and left the asset empty.
    const original = await cfs.files.read(assetId, "original.png");
    expect(original.ok).toBe(false);
  });

  it.each([
    ["seedance2_video", true],
    ["fal_seedance2_i2v", false],
  ] as const)("records KIE metadata only for KIE-backed shared video task %s", async (taskType, expectKieMetadata) => {
    const { assetId, assetDir, taskId, bookId, fs: cfs } = await seedPendingTask(taskType, "video");
    registerCompleteProviderTaskJob(cfs);
    registerJobHandler("process_video", async () => ({ ok: true }));

    const result = await appQueue.enqueueAndWait<{ success: boolean }>(
      `complete-video-${assetId}`,
      {
        type: "complete_kie_task",
        taskId,
        taskType,
        assetId,
        assetDir,
        bookId,
        meta: {},
        resultUrls: taskType === "seedance2_video" ? [imageUrl] : [],
        ...(taskType.startsWith("fal_")
          ? { resultObject: { video: { url: imageUrl } } }
          : {}),
      },
      10_000,
    );

    expect(result.success).toBe(true);
    const taskMetadata = await cfs.metadata.artifacts.read<{ taskId: string }>(assetId, "kie-task-id");
    expect(taskMetadata.ok).toBe(expectKieMetadata);
    if (taskMetadata.ok) {
      expect(taskMetadata.value).toEqual({ taskId });
    }
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
