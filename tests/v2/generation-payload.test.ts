import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import { generationPayloadDef } from "../../server/src/tools/generation-payload.js";

describe("generation payload inspection", () => {
  let rootDir: string;
  let engine: Engine;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-generation-payload-"));
    engine = createEngine({ durableWrites: false, rootDir,
    initialBookName: "generation-payload", });
    await engine.ready;
  });

  afterEach(async () => {
    engine.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("serializes the persisted millisecond failure timestamp without changing details", async () => {
    const artifact = await engine.artifacts.create("video", "failed generation");
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) return;
    const payload = {
      model: "kling-3.0/motion-control",
      input: { prompt: "A dancer turns toward camera" },
    };
    expect((await engine.metadata.artifacts.write(
      artifact.value.artifactId,
      "generation-payload",
      payload,
    )).ok).toBe(true);
    expect((await engine.jobs.failures.write(artifact.value.artifactId, {
      message: "No valid characters detected in the video",
      failCode: "400",
      prompt: "A dancer turns toward camera",
    })).ok).toBe(true);
    const persisted = await engine.jobs.failures.read(artifact.value.artifactId);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok || !persisted.value) return;

    const result = await generationPayloadDef(engine).handler({
      book_id: engine.book.get().bookId,
      asset_id: artifact.value.artifactId,
    });
    expect(result.isError).toBeUndefined();
    const value = JSON.parse(result.content[0]!.text) as {
      payload: unknown;
      meta: unknown;
      error: {
        message: string;
        failedAt: string;
        failCode: string;
        prompt: string;
      };
      taskType: unknown;
      task: unknown;
    };
    expect(value).toEqual({
      payload,
      meta: null,
      error: {
        message: persisted.value.message,
        failedAt: new Date(persisted.value.failedAt).toISOString(),
        failCode: persisted.value.failCode,
        prompt: persisted.value.prompt,
      },
      taskType: null,
      task: null,
    });
  });
});
