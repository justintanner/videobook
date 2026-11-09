import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { createEngineForTest } from "../engine.js";
import {
  configureProviderPollDriverForTests,
  isProviderPollDriverActive,
  queue,
  resetProviderPollDriverForTests,
  setEngineRoot,
  setProviderPollTickHookForTests,
  stopBookQueue,
} from "../queue.js";
import { pollPendingProviderTasks } from "./reconcile-project-work.js";
import { testBudget } from "../test-budget.js";

async function seedPendingTask(
  fs: Engine,
  taskType = "gpt_image",
  taskId = "synthetic-provider-task",
  meta: Record<string, unknown> = {},
): Promise<{ assetSlug: string; taskId: string }> {
  const asset = await fs.artifacts.create("img", "poll-seed");
  if (!asset.ok) throw new Error(asset.error.message);

  const lease = await fs.jobs.artifactWork.begin(asset.value.artifactId, {
    kind: "generate",
    ownerKind: "job",
    durationMs: 60_000,
  });
  if (!lease) throw new Error("assetWork.begin failed");

  const written = await fs.jobs.pending.write(
    {
      artifactId: asset.value.artifactId,
      taskId,
      taskType,
      meta: { prompt: "a test image", ...meta },
    },
    lease.ownerId,
  );
  if (!written.ok) throw new Error(written.error.message);
  if (!written.value) throw new Error("pending write lost lease");

  return { assetSlug: asset.value.artifactId, taskId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withFalQueue(
  respond: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseURL: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    request.resume();
    respond(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  const previousKey = process.env.FAL_API_KEY;
  process.env.FAL_API_KEY = "local-poll-key";
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    if (previousKey === undefined) delete process.env.FAL_API_KEY;
    else process.env.FAL_API_KEY = previousKey;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function falHttp(code: number, body: unknown, response: ServerResponse): void {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

describe("pollPendingProviderTasks", () => {
  let fs: Engine;
  let tempDir: string;
  let bookId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vb-poll-provider-"));
    fs = createEngineForTest(tempDir);
    await fs.ready;
    await setEngineRoot(tempDir, fs);
    bookId = fs.book.get().bookId;
  });

  afterEach(async () => {
    resetProviderPollDriverForTests();
    await queue.stop();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("is a no-op when the book has no pending tasks", async () => {
    const result = await pollPendingProviderTasks(fs, bookId);
    expect(result.pending).toEqual([]);
    expect(result.completed).toEqual([]);
    expect(result.failed).toEqual([]);

    const stillPending = await fs.jobs.pending.findAll();
    expect(stillPending.ok).toBe(true);
    if (stillPending.ok) expect(stillPending.value).toEqual([]);
  });

  it.each([
    { endpoint: "minimax/h3-max/insert-video", field: "start_time", message: "Start time must be within the source video", guidance: "" },
    { endpoint: "minimax/h3-max/reframe-video", field: "video_url", message: "Canvas and source_scale leave no area to outpaint",
      guidance: ". Choose a different aspect ratio to expand the surroundings, or use a video editing model to change the existing picture." },
  ])("keeps actionable Fal validation details for $endpoint on the failed artifact", async ({ endpoint, field, message, guidance }) => {
    const { assetSlug } = await seedPendingTask(fs, "fal_media", "invalid-input", { falEndpointId: endpoint });
    const server = createServer((request, response) => {
      request.resume();
      const status = request.url?.endsWith("/status");
      response.writeHead(status ? 200 : 422, { "content-type": "application/json" });
      response.end(JSON.stringify(status ? { status: "COMPLETED" } : {
        detail: [{ loc: ["body", field], msg: message }],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    const previousKey = process.env.FAL_API_KEY;
    process.env.FAL_API_KEY = "local-poll-key";
    try {
      const result = await pollPendingProviderTasks(fs, bookId, { falQueueBaseURL: `http://127.0.0.1:${address.port}` });
      const expected = `Fal API error: 422: ${field}: ${message}${guidance}`;
      expect(result.failed[0]?.failMsg).toBe(expected);
      const failure = fs.jobs.failures.read(assetSlug);
      expect(failure.ok && failure.value?.message).toBe(expected);
    } finally {
      if (previousKey === undefined) delete process.env.FAL_API_KEY;
      else process.env.FAL_API_KEY = previousKey;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    { phase: "status", code: 408 },
    { phase: "status", code: 429 },
    { phase: "status", code: 499 },
    { phase: "result", code: 408 },
    { phase: "result", code: 429 },
    { phase: "result", code: 499 },
  ])("leaves a fal task pending when the $phase poll answers $code", async ({ phase, code }) => {
    const { assetSlug } = await seedPendingTask(fs, "fal_media", "fal-throttled", { falEndpointId: "minimax/h3-max/extend-video" });
    await withFalQueue((request, response) => {
      const isStatus = request.url?.endsWith("/status") ?? false;
      if (phase === "status" && isStatus) {
        falHttp(code, { message: "throttled" }, response);
        return;
      }
      if (phase === "result" && !isStatus) {
        falHttp(code, { message: "throttled" }, response);
        return;
      }
      falHttp(200, { status: "COMPLETED" }, response);
    }, async (baseURL) => {
      const result = await pollPendingProviderTasks(fs, bookId, { falQueueBaseURL: baseURL });
      expect(result.completed).toEqual([]);
      expect(result.failed).toEqual([expect.objectContaining({ assetId: assetSlug, failMsg: `Fal API error: ${code}` })]);
      expect(fs.jobs.pending.read(assetSlug)).toMatchObject({ ok: true, value: expect.objectContaining({ taskId: "fal-throttled" }) });
      expect(fs.jobs.failures.read(assetSlug)).toMatchObject({ ok: true, value: null });
    });
  });

  it.each([
    { phase: "status", code: 400 },
    { phase: "result", code: 404 },
  ])("fails a fal task when the $phase poll answers $code", async ({ phase, code }) => {
    const { assetSlug } = await seedPendingTask(fs, "fal_media", "fal-rejected", { falEndpointId: "minimax/h3-max/extend-video" });
    await withFalQueue((request, response) => {
      const isStatus = request.url?.endsWith("/status") ?? false;
      if ((phase === "status" && isStatus) || (phase === "result" && !isStatus)) {
        falHttp(code, { message: "rejected" }, response);
        return;
      }
      falHttp(200, { status: "COMPLETED" }, response);
    }, async (baseURL) => {
      const result = await pollPendingProviderTasks(fs, bookId, { falQueueBaseURL: baseURL });
      const expected = `Fal API error: ${code}`;
      expect(result.failed).toEqual([expect.objectContaining({ assetId: assetSlug, failMsg: expected })]);
      expect(fs.jobs.pending.read(assetSlug)).toMatchObject({ ok: true, value: null });
      const failure = fs.jobs.failures.read(assetSlug);
      expect(failure.ok && failure.value?.message).toBe(expected);
    });
  });

  it("polls a throttled fal result again on the next reconcile pass", async () => {
    const { assetSlug } = await seedPendingTask(fs, "fal_media", "fal-retry", { falEndpointId: "minimax/h3-max/extend-video" });
    let resultCode = 429;
    await withFalQueue((request, response) => {
      if (request.url?.endsWith("/status")) {
        falHttp(200, { status: "COMPLETED" }, response);
        return;
      }
      falHttp(resultCode, { detail: [{ loc: ["body", "video_url"], msg: "Invalid video" }] }, response);
    }, async (baseURL) => {
      const throttled = await pollPendingProviderTasks(fs, bookId, { falQueueBaseURL: baseURL });
      expect(throttled.failed).toEqual([expect.objectContaining({ assetId: assetSlug, failMsg: expect.stringContaining("Fal API error: 429") })]);
      expect(fs.jobs.pending.read(assetSlug)).toMatchObject({ ok: true, value: expect.objectContaining({ taskId: "fal-retry" }) });
      expect(fs.jobs.failures.read(assetSlug)).toMatchObject({ ok: true, value: null });

      resultCode = 422;
      const rejected = await pollPendingProviderTasks(fs, bookId, { falQueueBaseURL: baseURL });
      const expected = "Fal API error: 422: video_url: Invalid video";
      expect(rejected.failed).toEqual([expect.objectContaining({ assetId: assetSlug, failMsg: expected })]);
      expect(fs.jobs.pending.read(assetSlug)).toMatchObject({ ok: true, value: null });
      const failure = fs.jobs.failures.read(assetSlug);
      expect(failure.ok && failure.value?.message).toBe(expected);
    });
  });

  it.each([
    { taskType: "media_removed", meta: {} },
    { taskType: "seedance2_video", meta: { model: "retired:video-model" } },
  ])("does not poll unsupported $taskType records through Kie", async ({ taskType, meta }) => {
    const { assetSlug } = await seedPendingTask(fs, taskType, "unsupported-task", meta);
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 200, data: { taskId: "unsupported-task", state: "waiting" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    const previousKey = process.env.KIE_API_KEY;
    process.env.KIE_API_KEY = "local-poll-key";
    try {
      const result = await pollPendingProviderTasks(fs, bookId, { kieBaseURL: `http://127.0.0.1:${address.port}` });
      expect(requests).toBe(0);
      expect(result.completed).toEqual([]);
      expect(result.failed).toEqual([]);
      const pending = fs.jobs.pending.read(assetSlug);
      expect(pending.ok && pending.value?.taskId).toBe("unsupported-task");
    } finally {
      if (previousKey === undefined) delete process.env.KIE_API_KEY;
      else process.env.KIE_API_KEY = previousKey;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("ages out stale non-completing tasks via injectable timeout", async () => {
    const { assetSlug } = await seedPendingTask(fs);
    const before = await fs.jobs.pending.findAll();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value).toHaveLength(1);

    const result = await pollPendingProviderTasks(fs, bookId, {
      timeoutMs: 1_000,
      nowMs: Date.now() + 60_000,
    });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.assetId).toBe(assetSlug);
    expect(result.failed[0]?.failMsg).toMatch(/timed out/i);
    expect(result.pending).toEqual([]);
    expect(result.completed).toEqual([]);

    const after = await fs.jobs.pending.findAll();
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.value).toEqual([]);
  });

  it("driver ticks poller when pending rows exist and stopBookQueue halts it", async () => {
    configureProviderPollDriverForTests({
      intervalMs: 50,
      timeoutMs: 1,
    });
    // Restart runner so the timer picks up the short interval
    await stopBookQueue(bookId);
    await setEngineRoot(tempDir, fs);

    expect(isProviderPollDriverActive(bookId)).toBe(true);

    let ticks = 0;
    setProviderPollTickHookForTests(() => {
      ticks += 1;
    });

    await seedPendingTask(fs, "gpt_image", "driver-lifecycle-task");
    // Allow createdAt to exceed 1ms timeout, then wait for at least one tick
    await sleep(120);

    const deadline = Date.now() + testBudget(3_000);
    while (Date.now() < deadline) {
      const pending = await fs.jobs.pending.findAll();
      if (pending.ok && pending.value.length === 0 && ticks >= 1) break;
      await sleep(40);
    }

    expect(ticks).toBeGreaterThanOrEqual(1);
    const agedOut = await fs.jobs.pending.findAll();
    expect(agedOut.ok).toBe(true);
    if (agedOut.ok) expect(agedOut.value).toEqual([]);

    const ticksAtStop = ticks;
    await stopBookQueue(bookId);
    expect(isProviderPollDriverActive(bookId)).toBe(false);

    await sleep(200);
    expect(ticks).toBe(ticksAtStop);
  });

  it("settles a Seedance task when recordInfo reports success outside a job", async () => {
    const { assetSlug } = await seedPendingTask(fs, "seedance2_video", "seedance-task");
    fs.usage.record({
      id: "seedance-poll", provider: "kie", model: "bytedance/seedance-2-5", activity: "video",
      status: "pending", basis: "estimated", costUsd: 5.7, units: 10, unit: "seconds",
      externalId: "seedance-task", artifactId: assetSlug, tokenBased: false,
    });
    const server: Server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          code: 200,
          data: {
            taskId: "seedance-task",
            state: "success",
            resultJson: JSON.stringify({ resultUrls: ["https://example.test/clip.mp4"] }),
          },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    const previousKey = process.env.KIE_API_KEY;
    process.env.KIE_API_KEY = "local-poll-key";
    try {
      const result = await pollPendingProviderTasks(fs, bookId, { kieBaseURL: `http://127.0.0.1:${address.port}` });
      expect(result.completed.map((entry) => entry.assetId)).toEqual([assetSlug]);
      expect(fs.usage.find("kie", "seedance-task")?.status).toBe("completed");
      expect(fs.usage.summary().totals).toMatchObject({ pendingCount: 0, estimatedUsd: 5.7 });
    } finally {
      if (previousKey === undefined) delete process.env.KIE_API_KEY;
      else process.env.KIE_API_KEY = previousKey;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
