import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { enqueueOptions, queue, setEngineRoot } from "../queue.js";
import { registerPostToXJob } from "./post-to-x.js";

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

type JobErrorLogEntry = {
  assetId?: string;
  detached?: boolean;
  errorCode?: string;
  jobType?: string;
  rolledBack?: boolean;
};

function valueOf<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function createReadyImage(engine: Engine): Promise<string> {
  const created = valueOf(await engine.artifacts.create("img", "poster"));
  valueOf(await engine.files.write(created.artifactId, "original.png", MINIMAL_PNG));
  const lease = engine.jobs.artifactWork.begin(created.artifactId, {
    kind: "process",
    ownerKind: "job",
    durationMs: 60_000,
  });
  if (!lease) throw new Error(`could not lease ${created.artifactId}`);
  engine.jobs.artifactWork.complete(created.artifactId, lease.ownerId);
  return created.artifactId;
}

describe("post_to_x job", () => {
  let projectsDir: string;
  let engine: Engine;
  let bookId: string;

  beforeEach(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), "videobook-post-to-x-"));
    engine = createEngineForTest(projectsDir);
    await setEngineRoot(projectsDir, engine);
    bookId = engine.book.get().bookId;
    registerPostToXJob(engine);
  });

  afterEach(async () => {
    await queue.stop();
    closeEngineForTest(projectsDir, engine);
    await rm(projectsDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("enqueues detached from the artifact row", () => {
    const options = enqueueOptions("post-x-detached", {
      type: "post_to_x",
      assetId: "01a00000-0000-7000-8000-000000000000",
      bookId,
    });
    expect(options.artifactId).toBeNull();
    expect(options.artifactWorkKind).toBeNull();
  });

  it("leaves the asset ready when no X account is connected", async () => {
    // vitest.setup.ts strips X_ACCESS_TOKEN and points the application state
    // at an empty per-worker file, so the post fails before any network call.
    const assetId = await createReadyImage(engine);
    expect(valueOf(await engine.status.get(assetId))).toBe("ready");

    await expect(queue.enqueueAndWait("post-x-no-token", {
      type: "post_to_x",
      assetId,
      bookId,
      text: "hello",
    }, 10_000)).rejects.toThrow(/No X access token is configured/);

    const status = await queue.getStatus("post-x-no-token");
    expect(status?.state).toBe("failed");
    expect(status?.error?.message).toMatch(/No X access token is configured/);

    // Publishing is auxiliary to the media: the asset keeps its status and
    // carries no failure record, so its cell never shows "media failed".
    expect(valueOf(await engine.status.get(assetId))).toBe("ready");
    expect(valueOf(engine.jobs.artifactWork.read(assetId))?.status).toBe("ready");
    expect(valueOf(engine.jobs.failures.read(assetId))).toBeNull();

    // The attempt stays auditable in the append-only action log.
    const jobErrors = engine.logs.read("job-error", { limit: 25 }) as unknown as JobErrorLogEntry[];
    expect(jobErrors.some((entry) =>
      entry.jobType === "post_to_x"
      && entry.assetId === assetId
      && entry.detached === true
      && entry.errorCode === "UNKNOWN")).toBe(true);
  });
});
