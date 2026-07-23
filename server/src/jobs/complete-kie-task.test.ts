import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsP from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createServer, type Server } from "node:http";
import { createFs } from "videobook-engine";
import {
  queue as appQueue,
  registerJobHandler,
  setProjectsDir,
} from "../queue.js";
import { registerCompleteKieTaskJob } from "./complete-kie-task.js";

// 1x1 PNG
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

describe("complete-kie-task job handler", () => {
  it("exports registerCompleteKieTaskJob function", async () => {
    const mod = await import("./complete-kie-task.js");
    expect(typeof mod.registerCompleteKieTaskJob).toBe("function");
  });

  it("registerCompleteKieTaskJob accepts a fs argument", async () => {
    const mod = await import("./complete-kie-task.js");
    expect(mod.registerCompleteKieTaskJob.length).toBe(1);
  });
});

describe("complete_kie_task fal_qwen branches", () => {
  let projectsDir: string;
  let imageServer: Server;
  let imageUrl: string;

  beforeEach(async () => {
    projectsDir = await fsP.mkdtemp(path.join(os.tmpdir(), "vc-complete-qwen-"));
    await setProjectsDir(projectsDir);

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
    await new Promise<void>((resolve, reject) => {
      imageServer.close((err) => (err ? reject(err) : resolve()));
    });
    await fsP.rm(projectsDir, { recursive: true, force: true });
  });

  async function seedPendingQwenTask(
    taskType: "fal_qwen_image" | "fal_qwen_image_edit",
  ): Promise<{ assetId: string; assetDir: string; taskId: string; fs: ReturnType<typeof createFs> }> {
    const cfs = createFs({ projectsDir });
    await setProjectsDir(projectsDir, cfs);
    const created = await cfs.createProject("p");
    expect(created.ok).toBe(true);
    const asset = await cfs.createAsset("img", "qwen-out", "p");
    expect(asset.ok).toBe(true);
    if (!asset.ok) throw new Error(asset.error.message);

    const lease = await cfs.assetWork.begin("p", asset.value.assetId, {
      kind: "generate",
      ownerKind: "job",
      durationMs: 60_000,
    });
    if (!lease) throw new Error("assetWork.begin failed");

    const taskId = `fal-qwen-task-${taskType}`;
    const written = await cfs.pendingTasks.write(
      "p",
      {
        taskId,
        taskType,
        assetId: asset.value.assetId,
        assetDir: asset.value.path,
        meta: { prompt: "a cat", sourceImageIds: [] },
      },
      lease.ownerId,
    );
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error(written.error.message);

    return {
      assetId: asset.value.assetId,
      assetDir: asset.value.path,
      taskId,
      fs: cfs,
    };
  }

  it("downloads fal_qwen_image_edit result instead of marking ready empty", async () => {
    const { assetId, assetDir, taskId, fs: cfs } = await seedPendingQwenTask("fal_qwen_image_edit");
    registerCompleteKieTaskJob(cfs);
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
        projectSlug: "p",
        meta: { prompt: "a cat", sourceImageIds: [] },
        resultUrls: [],
        resultObject: { images: [{ url: imageUrl }] },
      },
      10_000,
    );

    expect(result.success).toBe(true);

    const original = await cfs.readFile(assetId, "original.png", "p");
    expect(original.ok).toBe(true);
    if (original.ok) {
      const buf = typeof original.value === "string"
        ? Buffer.from(original.value)
        : Buffer.from(original.value);
      expect(buf.equals(TINY_PNG)).toBe(true);
    }

    const pending = await cfs.pendingTasks.read("p", assetId);
    expect(pending.ok).toBe(true);
    expect(pending.ok ? pending.value : "fail").toBeNull();

    cfs.close();
  });

  it("downloads fal_qwen_image (T2I) result", async () => {
    const { assetId, assetDir, taskId, fs: cfs } = await seedPendingQwenTask("fal_qwen_image");
    registerCompleteKieTaskJob(cfs);
    registerJobHandler("process_image", async () => ({ ok: true }));

    const result = await appQueue.enqueueAndWait<{ success: boolean }>(
      `complete-qwen-t2i-${assetId}`,
      {
        type: "complete_kie_task",
        taskId,
        taskType: "fal_qwen_image",
        assetId,
        assetDir,
        projectSlug: "p",
        meta: { prompt: "a dog", sourceImageIds: [] },
        resultUrls: [],
        resultObject: { images: [{ url: imageUrl }] },
      },
      10_000,
    );

    expect(result.success).toBe(true);

    const original = await cfs.readFile(assetId, "original.png", "p");
    expect(original.ok).toBe(true);

    cfs.close();
  });

  it("fails when fal_qwen result has no image URLs (no silent ready)", async () => {
    const { assetId, assetDir, taskId, fs: cfs } = await seedPendingQwenTask("fal_qwen_image_edit");
    registerCompleteKieTaskJob(cfs);

    await expect(
      appQueue.enqueueAndWait(
        `complete-qwen-empty-${assetId}`,
        {
          type: "complete_kie_task",
          taskId,
          taskType: "fal_qwen_image_edit",
          assetId,
          assetDir,
          projectSlug: "p",
          meta: { prompt: "a cat", sourceImageIds: [] },
          resultUrls: [],
          resultObject: { images: [] },
        },
        10_000,
      ),
    ).rejects.toThrow(/No image URL in result/i);

    // Regression: prior bug deleted the pending task and left the asset empty.
    const original = await cfs.readFile(assetId, "original.png", "p");
    expect(original.ok).toBe(false);

    cfs.close();
  });
});
