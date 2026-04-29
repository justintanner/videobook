import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFs } from "clipfirst-fs";
import type { ClipfirstFs } from "clipfirst-fs";
import {
  writePendingTask,
  readPendingTask,
  deletePendingTask,
  failPendingTask,
  findPendingTasks,
  type PendingKieTask,
} from "./pending-task.js";

function makeTask(assetId: string, assetDir: string, projectSlug: string): PendingKieTask {
  return {
    taskId: `task-${assetId}`,
    taskType: "transcribe",
    assetId,
    assetDir,
    projectSlug,
    createdAt: new Date().toISOString(),
    meta: {},
  };
}

async function createAssetOk(fs: ClipfirstFs, prefix: string, name: string, projectSlug: string) {
  const result = await fs.createAsset(prefix, name, projectSlug);
  if (!result.ok) throw new Error(`createAsset failed: ${result.error.message}`);
  return result.value;
}

describe("pending-task", () => {
  let fs: ClipfirstFs;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
    fs = createFs({ projectsDir: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("readPendingTask with no task returns null", async () => {
    await fs.createProject("test");
    const { assetId } = await createAssetOk(fs, "vid", "sample-clip", "test");
    const result = await readPendingTask(fs, assetId, "test");
    expect(result).toBeNull();
  });

  it("writePendingTask then readPendingTask returns the task", async () => {
    await fs.createProject("test");
    const { assetId, path: assetDir } = await createAssetOk(fs, "vid", "sample-clip", "test");
    const task = makeTask(assetId, assetDir, "test");

    await writePendingTask(fs, assetId, "test", task);
    const result = await readPendingTask(fs, assetId, "test");

    expect(result).not.toBeNull();
    expect(result!.taskId).toBe(task.taskId);
    expect(result!.taskType).toBe("transcribe");
    expect(result!.assetId).toBe(assetId);
  });

  it("writePendingTask then deletePendingTask then readPendingTask returns null", async () => {
    await fs.createProject("test");
    const { assetId, path: assetDir } = await createAssetOk(fs, "vid", "sample-clip", "test");
    const task = makeTask(assetId, assetDir, "test");

    await writePendingTask(fs, assetId, "test", task);
    await deletePendingTask(fs, assetId, "test");
    const result = await readPendingTask(fs, assetId, "test");

    expect(result).toBeNull();
  });

  it("failPendingTask records the error and deletes the pending task", async () => {
    await fs.createProject("test");
    const { assetId, path: assetDir } = await createAssetOk(fs, "vid", "sample-clip", "test");
    const task = makeTask(assetId, assetDir, "test");

    await writePendingTask(fs, assetId, "test", task);
    await failPendingTask(fs, assetId, "test", {
      message: "Kie content policy rejection",
      failCode: "430",
    });

    const pending = await readPendingTask(fs, assetId, "test");
    expect(pending).toBeNull();

    const errResult = await fs.generationErrors.read("test", assetId);
    expect(errResult.ok).toBe(true);
    if (errResult.ok && errResult.value) {
      expect(errResult.value.message).toBe("Kie content policy rejection");
      expect(errResult.value.failCode).toBe("430");
      expect(typeof errResult.value.failedAt).toBe("number");
    } else {
      throw new Error("expected generation error row");
    }
  });

  it("failPendingTask without failCode omits the field", async () => {
    await fs.createProject("test");
    const { assetId, path: assetDir } = await createAssetOk(fs, "vid", "sample-clip", "test");
    const task = makeTask(assetId, assetDir, "test");

    await writePendingTask(fs, assetId, "test", task);
    await failPendingTask(fs, assetId, "test", { message: "Poll timeout" });

    const errResult = await fs.generationErrors.read("test", assetId);
    expect(errResult.ok).toBe(true);
    if (errResult.ok && errResult.value) {
      expect(errResult.value.message).toBe("Poll timeout");
      expect(errResult.value.failCode).toBeUndefined();
    } else {
      throw new Error("expected generation error row");
    }
  });

  it("findPendingTasks returns only assets with tasks", async () => {
    await fs.createProject("test");
    const a1 = await createAssetOk(fs, "vid", "clip-alpha", "test");
    const a2 = await createAssetOk(fs, "vid", "clip-beta", "test");
    await createAssetOk(fs, "vid", "clip-gamma", "test");

    await writePendingTask(fs, a1.assetId, "test", makeTask(a1.assetId, a1.path, "test"));
    await writePendingTask(fs, a2.assetId, "test", makeTask(a2.assetId, a2.path, "test"));

    const assets = await fs.listAssets("test");
    const pending = await findPendingTasks(fs, "test", assets);

    expect(pending).toHaveLength(2);
    const ids = pending.map((t) => t.assetId).sort();
    expect(ids).toEqual([a1.assetId, a2.assetId].sort());
  });
});
