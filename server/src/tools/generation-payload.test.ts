import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { generationPayloadDef } from "./generation-payload.js";

type InspectResponse = {
  payload: unknown;
  taskType: string | null;
  meta: Record<string, unknown> | null;
  task: { taskId: string; submittedAt: string; completing: boolean } | null;
};

async function inspect(engine: Engine, assetId: string): Promise<InspectResponse> {
  const result = await generationPayloadDef(engine).handler({
    book_id: engine.book.get().bookId,
    asset_id: assetId,
  });
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected text content");
  return JSON.parse(text.text) as InspectResponse;
}

describe("inspect_generation_request tool", () => {
  let engine: Engine;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inspect-gen-request-"));
    engine = createEngineForTest(root);
    await engine.ready;
  });

  afterEach(async () => {
    if (root && engine) closeEngineForTest(root, engine);
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns the submitted payload with the in-flight provider task", async () => {
    const asset = await engine.artifacts.create("video", "inflight");
    if (!asset.ok) throw new Error(asset.error.message);
    const artifactId = asset.value.artifactId;
    const request = { model: "gemini-omni-video", input: { prompt: "dance", duration: "8" } };
    await engine.metadata.artifacts.write(artifactId, "generation-payload", request);
    const lease = await engine.jobs.artifactWork.begin(artifactId, {
      kind: "generate",
      ownerKind: "job",
      durationMs: 60_000,
    });
    if (!lease) throw new Error("artifactWork.begin failed");
    const before = Date.now();
    const written = await engine.jobs.pending.write(
      { artifactId, taskId: "task-123", taskType: "gemini_omni_video", meta: { prompt: "dance" } },
      lease.ownerId,
    );
    if (!written.ok || !written.value) throw new Error("pending write failed");

    const response = await inspect(engine, artifactId);

    expect(response.payload).toEqual(request);
    expect(response.taskType).toBe("gemini_omni_video");
    expect(response.task).toMatchObject({ taskId: "task-123", completing: false });
    expect(Date.parse(response.task?.submittedAt ?? "")).toBeGreaterThanOrEqual(before - 1000);
  });

  it("reports no task once nothing is pending", async () => {
    const asset = await engine.artifacts.create("image", "settled");
    if (!asset.ok) throw new Error(asset.error.message);

    const response = await inspect(engine, asset.value.artifactId);

    expect(response.payload).toBeNull();
    expect(response.task).toBeNull();
  });
});
