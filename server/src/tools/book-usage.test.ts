import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "videobook-engine";
import type { Engine } from "videobook-engine";
import { createOpenAi, createFal, createElevenLabs } from "../usage-providers.js";
import { withBookContext, scopedBookEngine } from "../book-context.js";
import { providerUsageFetch, recordVoiceUsage, recordTranscriptionUsage } from "../provider-usage.js";
import { bookUsageDef } from "./book-usage.js";

describe("provider usage through real HTTP and engine storage", () => {
  let root: string;
  let engine: Engine;
  let server: Server;
  let url: string;
  let responseId: string;
  let mode: "normal" | "failure" | "disconnect";
  let reply: Record<string, unknown> | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vb-book-usage-"));
    engine = createEngine({ rootDir: root, initialBookName: "usage", durableWrites: false });
    await engine.ready;
    responseId = "response-one";
    mode = "normal";
    reply = undefined;
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        if (mode === "disconnect") { request.socket.destroy(); return; }
        if (request.url?.includes("text-to-speech")) {
          response.writeHead(200, { "content-type": "audio/mpeg" });
          response.end(Buffer.from([1, 2, 3]));
          return;
        }
        response.writeHead(mode === "failure" ? 500 : 200, { "content-type": "application/json" });
        const body = request.url?.includes("recordInfo")
          ? { code: 200, data: { taskId: "kie-one", state: "success" } }
          : request.url?.includes("createTask")
            ? { code: 200, data: { taskId: "kie-one" } }
            : request.url?.endsWith("/status")
              ? { status: "COMPLETED", request_id: "fal-one" }
              : request.url?.includes("fal-ai")
                ? { request_id: "fal-one", status: "IN_QUEUE" }
                : { id: responseId, status: mode === "failure" ? "failed" : "completed", output: [], usage: { input_tokens: 1200, output_tokens: 300, input_tokens_details: { cached_tokens: 200 } } };
        response.end(JSON.stringify(reply ?? body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    url = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    engine.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  function scoped<T>(operation: () => Promise<T>, target = engine) {
    return withBookContext({ bookId: target.book.get().bookId, engine: target, operation: "chat" }, operation);
  }

  it("records measured tokens and estimates once per provider response, without saving prompts", async () => {
    const provider = createOpenAi({ apiKey: "test", baseURL: `${url}/v1` });
    await scoped(() => provider.post.v1.responses({ model: "gpt-4o", input: "private prompt" }));
    await scoped(() => provider.post.v1.responses({ model: "gpt-4o", input: "private prompt" }));
    expect(engine.usage.summary().totals).toMatchObject({ count: 1, inputTokens: 1200, outputTokens: 300, cachedTokens: 200, estimatedUsd: 0.006, unpriced: 0 });
    const result = await bookUsageDef(engine).handler({ book_id: engine.book.get().bookId });
    expect(result.content[0]?.text).not.toContain("private prompt");
    expect(JSON.parse(result.content[0]!.text).recent).toHaveLength(1);
  });

  it("keeps pending generation estimates separate and settles each polled job only once", async () => {
    const provider = createFal({ apiKey: "test", queueBaseURL: url });
    await scoped(() => provider.post.v1.queue.submit({ endpoint_id: "fal-ai/nano-banana", input: { prompt: "test" } }));
    expect(engine.usage.summary().totals).toMatchObject({ pendingCount: 1, estimatedUsd: 0 });
    for (let i = 0; i < 3; i++) await scoped(() => provider.v1.queue.status({ endpoint_id: "fal-ai/nano-banana", request_id: "fal-one" }));
    expect(engine.usage.summary().totals).toMatchObject({ count: 1, pendingCount: 0 });
    const transport = providerUsageFetch("kie");
    await scoped(() => transport(`${url}/api/v1/jobs/createTask`, { method: "POST", body: JSON.stringify({ model: "qwen2/text-to-image", input: { prompt: "test" } }) }));
    expect(engine.usage.summary().totals.pendingCount).toBe(1);
    await scoped(() => transport(`${url}/api/v1/jobs/recordInfo?taskId=kie-one`));
    expect(engine.usage.summary().totals).toMatchObject({ count: 2, pendingCount: 0 });
    expect(engine.usage.find("kie", "kie-one")?.costUsd).toBe(0.028);
    await scoped(() => transport(`${url}/api/v1/jobs/recordInfo?taskId=old-task`));
    expect(engine.usage.summary().totals.count).toBe(2);
  });


  it("records fal Alibaba routes and resolves polling by request id rather than output id", async () => {
    const transport = providerUsageFetch("fal");
    reply = { request_id: "fal-alibaba", status: "IN_QUEUE" };
    await scoped(() => transport(`${url}/alibaba/qwen-image-3/edit`, { method: "POST", body: JSON.stringify({ prompt: "test", image_urls: ["https://example.test/image.png"] }) }));
    reply = { id: "output-id", usage: { cost_usd: 0.3 } };
    await scoped(() => transport(`${url}/alibaba/qwen-image-3/requests/fal-alibaba`));
    expect(engine.usage.summary().totals).toMatchObject({ count: 1, pendingCount: 0, reportedUsd: 0.3, unpriced: 0 });
    expect(engine.usage.recent()[0]?.model).toBe("alibaba/qwen-image-3/edit");
  });

  it("excludes fal uploads and request control calls from spend", async () => {
    const transport = providerUsageFetch("fal");
    for (const path of ["/storage/upload/initiate", "/minimax/h3-max/requests/fal-one/cancel"]) {
      await scoped(() => transport(`${url}${path}`, { method: "POST", body: "{}" }));
    }
    expect(engine.usage.recent()).toEqual([]);
  });

  it("settles xAI video and Alibaba media through their own task polling shapes", async () => {
    const xai = providerUsageFetch("xai");
    reply = { request_id: "xai-video" };
    await scoped(() => xai(`${url}/v1/videos/generations`, { method: "POST", body: JSON.stringify({ model: "grok-imagine-video", duration: 6 }) }));
    expect(engine.usage.summary().totals).toMatchObject({ pendingCount: 1, pendingUsd: 0.3 });
    reply = { status: "done", video: { url: "https://example.test/video.mp4" }, usage: { cost_in_usd_ticks: 2_400_000_000 } };
    await scoped(() => xai(`${url}/v1/videos/xai-video`));
    expect(engine.usage.summary().totals).toMatchObject({ pendingCount: 0, estimatedUsd: 0, reportedUsd: 0.24 });
    const alibaba = providerUsageFetch("alibaba");
    reply = { output: { task_id: "alibaba-image", task_status: "PENDING" } };
    await scoped(() => alibaba(`${url}/api/v1/services/aigc/multimodal-generation/generation`, { method: "POST", body: JSON.stringify({ model: "qwen-image-2.0", input: {}, parameters: { n: 1 } }) }));
    reply = { output: { task_id: "alibaba-image", task_status: "SUCCEEDED" } };
    await scoped(() => alibaba(`${url}/api/v1/tasks/alibaba-image`));
    expect(engine.usage.summary().totals).toMatchObject({ count: 2, pendingCount: 0, unpriced: 0 });
    expect(engine.usage.find("alibaba", "alibaba-image")?.costUsd).toBeGreaterThan(0);
  });

  it("prefers reported charges and treats retries with different response ids as new spend", async () => {
    const provider = createOpenAi({ apiKey: "test", baseURL: `${url}/v1` });
    await scoped(() => provider.post.v1.responses({ model: "gpt-4o", input: "test" }));
    reply = { id: "response-two", usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.001 } };
    await scoped(() => provider.post.v1.responses({ model: "gpt-4o", input: "test" }));
    expect(engine.usage.summary().totals).toMatchObject({ count: 2, inputTokens: 1210, outputTokens: 305, estimatedUsd: 0.006, reportedUsd: 0.001 });
  });

  it("returns provider success even when usage cannot be recorded and discloses incomplete accounting", async () => {
    const provider = createOpenAi({ apiKey: "test", baseURL: `${url}/v1` });
    reply = { id: "invalid-usage", output: [], usage: { input_tokens: 1.5, output_tokens: 5 } };
    const response = await scoped(() => provider.post.v1.responses({ model: "gpt-4o", input: "test" }));
    expect(response.id).toBe("invalid-usage");
    const summary = await scoped(() => bookUsageDef(scopedBookEngine).handler({ book_id: engine.book.get().bookId }));
    expect(JSON.parse(summary.content[0]!.text).incomplete).toBe(true);
  });

  it("prices binary speech by characters and excludes calls without a book", async () => {
    const provider = createElevenLabs({ apiKey: "test", baseURL: url });
    await scoped(() => provider.v1.textToSpeech("voice", { text: "Hello", model_id: "eleven_multilingual_v2" }));
    expect(engine.usage.summary().totals).toMatchObject({ count: 1, estimatedUsd: 0.0006, inputTokens: 0, missingTokens: 0 });
    await provider.v1.textToSpeech("voice", { text: "Hello", model_id: "eleven_multilingual_v2" });
    expect(engine.usage.summary().totals.count).toBe(1);
  });

  it("counts billed failed attempts, retains uncertain outcomes, and isolates books", async () => {
    const provider = createOpenAi({ apiKey: "test", baseURL: `${url}/v1` });
    mode = "failure";
    await expect(scoped(() => provider.post.v1.responses({ model: "gpt-4o", input: "test" }))).rejects.toThrow();
    expect(engine.usage.summary().totals).toMatchObject({ inputTokens: 1200, estimatedUsd: 0.006 });
    mode = "disconnect";
    await expect(scoped(() => provider.post.v1.responses({ model: "gpt-4o", input: "test" }))).rejects.toThrow();
    expect(engine.usage.summary().totals).toMatchObject({ count: 2, unpriced: 1 });
    const other = createEngine({ rootDir: join(root, "other"), initialBookName: "other", durableWrites: false });
    try {
      mode = "normal";
      responseId = "isolated";
      await scoped(() => provider.post.v1.responses({ model: "gpt-4o", input: "test" }), other);
      expect(other.usage.summary().totals.count).toBe(1);
      expect(engine.usage.summary().totals.count).toBe(2);
    } finally { other.close(); }
  });

  it("counts a finished Seedance generation once the video is ready", async () => {
    const created = await engine.artifacts.create("video", "seedance clip");
    if (!created.ok) throw new Error(created.error.message);
    const artifactId = created.value.artifactId;
    await engine.files.write(artifactId, "original.mp4", "video-data");
    const metadata = await engine.metadata.artifacts.write(artifactId, "original", { duration: 10, width: 1080, height: 1920 });
    if (!metadata.ok) throw new Error(metadata.error.message);
    engine.usage.record({
      id: "seedance-done", provider: "kie", model: "bytedance/seedance-2-5", activity: "video",
      status: "pending", basis: "estimated", costUsd: 5.7, units: 10, unit: "seconds",
      externalId: "seedance-task", artifactId, tokenBased: false,
    });
    const summary = await bookUsageDef(engine).handler({ book_id: engine.book.get().bookId });
    const body = JSON.parse(summary.content[0]!.text) as { totals: { pendingCount: number; estimatedUsd: number }; recent: Array<{ status: string; model: string }> };
    expect(body.recent[0]).toMatchObject({ model: "bytedance/seedance-2-5", status: "completed" });
    expect(body.totals.pendingCount).toBe(0);
    expect(body.totals.estimatedUsd).toBeCloseTo(5.7);
  });

  it("keeps Seedance usage pending while its provider task is still open", async () => {
    const created = await engine.artifacts.create("video", "seedance running");
    if (!created.ok) throw new Error(created.error.message);
    const artifactId = created.value.artifactId;
    const lease = await engine.jobs.artifactWork.begin(artifactId, { kind: "generate", ownerKind: "job", durationMs: 60_000 });
    if (!lease) throw new Error("asset lease failed");
    const written = await engine.jobs.pending.write({ artifactId, taskId: "seedance-open", taskType: "seedance2_video", meta: {} }, lease.ownerId);
    if (!written.ok || !written.value) throw new Error("pending task write failed");
    engine.usage.record({
      id: "seedance-open", provider: "kie", model: "bytedance/seedance-2-5", activity: "video",
      status: "pending", basis: "estimated", costUsd: 5.7, units: 10, unit: "seconds",
      externalId: "seedance-open", artifactId, tokenBased: false,
    });
    await bookUsageDef(engine).handler({ book_id: engine.book.get().bookId });
    expect(engine.usage.find("kie", "seedance-open")?.status).toBe("pending");
    expect(engine.usage.summary().totals.pendingCount).toBe(1);
  });

  it("persists each realtime response once and labels missing model rates", () => {
    const response = { status: "cancelled", usage: { input_tokens: 30, output_tokens: 10, input_token_details: { cached_tokens: 5, audio_tokens: 20 } } };
    recordVoiceUsage(engine, "openai", "gpt-realtime-2.1", "session", "response", response);
    recordVoiceUsage(engine, "openai", "gpt-realtime-2.1", "session", "response", response);
    expect(engine.usage.summary().totals).toMatchObject({ count: 1, inputTokens: 30, outputTokens: 10, cachedTokens: 5, unpriced: 1 });
    expect(engine.usage.recent()[0]?.status).toBe("cancelled");
    recordTranscriptionUsage(engine, "gpt-4o-mini-transcribe", "session", "input", { usage: { input_tokens: 20, output_tokens: 5 } });
    expect(engine.usage.summary().totals).toMatchObject({ count: 2, inputTokens: 50, outputTokens: 15, unpriced: 2 });
    expect(engine.usage.summary().groups.map((group) => group.activity)).toEqual(["analysis", "voice"]);
  });
});
