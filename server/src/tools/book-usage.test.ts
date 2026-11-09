import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeEstimate } from "@apicity/cost";
import { createEngine } from "videobook-engine";
import type { Engine } from "videobook-engine";
import { createOpenAi, createFal, createElevenLabs } from "../usage-providers.js";
import { withBookContext, scopedBookEngine } from "../book-context.js";
import { installFalDynamicEstimator } from "../media/cost.js";
import { FAL_RESULT_OMITTED_UNITS_WARNING, providerUsageFetch, recordVoiceUsage, recordTranscriptionUsage, withUsageCostHints } from "../provider-usage.js";
import { MODEL_ENTRIES } from "../media/catalog.js";
import { parseModelId } from "../media/model-id.js";
import { isKieVeoModel } from "../media/wire.js";
import { bookUsageDef } from "./book-usage.js";

const SUNO_PATHS: Record<string, string> = { "suno/generate": "/api/v1/generate", "suno/sounds-generate": "/api/v1/generate/sounds" };

setFlagsFromString("--expose-gc");
const forceGarbageCollection = runInNewContext("gc") as () => void;

async function collectDiscardedObjects(): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    forceGarbageCollection();
    await nextEventLoopTurn();
    await nextEventLoopTurn();
  }
}

describe("provider usage through real HTTP and engine storage", () => {
  let root: string;
  let engine: Engine;
  let server: Server;
  let url: string;
  let responseId: string;
  let mode: "normal" | "failure" | "disconnect";
  let reply: Record<string, unknown> | undefined;
  let replyStatus: number | undefined;
  let headers: Record<string, string>;
  let pricingRequests: Record<string, unknown>[];
  let receivedBodies: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vb-book-usage-"));
    engine = createEngine({ rootDir: root, initialBookName: "usage", durableWrites: false });
    await engine.ready;
    responseId = "response-one";
    mode = "normal";
    reply = undefined;
    replyStatus = undefined;
    headers = {};
    pricingRequests = [];
    receivedBodies = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (request.url === "/v1/models/pricing/estimate") {
          const pricing = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
          pricingRequests.push(pricing);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ total_cost: pricing.estimate_type === "unit_price" ? 0.21 : 0.42, currency: "USD" }));
          return;
        }
        receivedBodies.push(Buffer.concat(chunks).toString());
        if (mode === "disconnect") { request.socket.destroy(); return; }
        if (request.url?.includes("text-to-speech")) {
          response.writeHead(200, { "content-type": "audio/mpeg", ...headers });
          response.end(Buffer.from([1, 2, 3]));
          return;
        }
        response.writeHead(replyStatus ?? (mode === "failure" ? 500 : 200), { "content-type": "application/json", ...headers });
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

  function scoped<T>(operation: () => Promise<T>, target = engine, name = "chat") {
    return withBookContext({ bookId: target.book.get().bookId, engine: target, operation: name }, operation);
  }

  it("groups every billable KIE and fal catalog generation under its catalog media", async () => {
    const activity = { image: "images", video: "video", audio: "audio" } as const;
    const kie = providerUsageFetch("kie");
    const fal = providerUsageFetch("fal");
    const expected: Record<string, string> = {};
    const recorded: Record<string, string | undefined> = {};
    for (const entry of MODEL_ENTRIES) {
      const { provider, apiId } = parseModelId(entry.id)!;
      const sunoPath = provider === "kie" ? SUNO_PATHS[apiId] : undefined;
      const model = sunoPath ? String(entry.defaults?.model) : apiId;
      if (provider === "kie") {
        const path = sunoPath ?? (isKieVeoModel(apiId) ? "/api/v1/veo/generate" : "/api/v1/jobs/createTask");
        reply = sunoPath ? { code: 200, msg: "success", data: { taskId: apiId } } : undefined;
        await scoped(() => kie(`${url}${path}`, { method: "POST", body: JSON.stringify({ model, input: {} }) }), engine, "generate_media");
        reply = undefined;
      } else if (provider === "fal") {
        await scoped(() => fal(`${url}/${apiId}`, { method: "POST", body: JSON.stringify({ prompt: "test" }) }), engine, "generate_media");
      } else continue;
      const [row] = engine.usage.recent(1);
      expected[apiId] = activity[entry.media];
      recorded[apiId] = row?.model === model ? row.activity : undefined;
    }
    expect(Object.keys(recorded)).toEqual(expect.arrayContaining(Object.keys(SUNO_PATHS)));
    expect(recorded).toEqual(expected);
    const openai = createOpenAi({ apiKey: "test", baseURL: `${url}/v1` });
    responseId = "chat-turn";
    await scoped(() => openai.post.v1.responses({ model: "gpt-4o", input: "test" }));
    responseId = "cut-analysis";
    await scoped(() => openai.post.v1.responses({ model: "gpt-4o", input: "test" }), engine, "suggest_cuts");
    expect(engine.usage.recent(2).map((row) => row.activity).sort()).toEqual(["analysis", "chat"]);
  });

  it("prices declared cache writes and GPT-6 usage through Apicity", async () => {
    const transport = providerUsageFetch("openai");
    for (const model of ["gpt-5.6-sol", "gpt-6-astra"]) {
      reply = { id: model, usage: { input_tokens: 1200, output_tokens: 300, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 400 } } };
      await scoped(() => transport(`${url}/v1/responses`, { method: "POST", body: JSON.stringify({ model, input: "private" }) }));
      const estimate = computeEstimate({ provider: "openai", payload: { model }, costHints: { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 200, cacheWriteInputTokens: 400 } });
      expect(estimate.warnings).toEqual([]);
      expect(engine.usage.find("openai", model)).toMatchObject({ basis: "estimated", costUsd: estimate.usd, cacheWriteTokens: 400 });
    }
  });

  it("prices transcription seconds and KIE terminal credits", async () => {
    const openai = providerUsageFetch("openai");
    reply = { id: "transcribed", usage: { seconds: 60 } };
    await scoped(() => openai(`${url}/v1/audio/transcriptions`, { method: "POST", body: JSON.stringify({ model: "gpt-transcribe" }) }));
    const expected = computeEstimate({ provider: "openai", payload: { model: "gpt-transcribe" }, costHints: { durationSeconds: 60 } });
    expect(engine.usage.find("openai", "transcribed")).toMatchObject({ costUsd: expected.usd, basis: "estimated", units: 60, unit: "seconds" });
    const kie = providerUsageFetch("kie");
    reply = { data: { taskId: "credits" } };
    await scoped(() => kie(`${url}/api/v1/jobs/createTask`, { method: "POST", body: JSON.stringify({ model: "qwen2/text-to-image", input: {} }) }));
    reply = { data: { taskId: "credits", state: "success", creditsConsumed: 12 } };
    await scoped(() => kie(`${url}/api/v1/jobs/recordInfo?taskId=credits`));
    expect(engine.usage.find("kie", "credits")).toMatchObject({ costUsd: 0.06, basis: "reported", units: 12, unit: "credits" });
  });

  it("prices terminal fal units and retains ElevenLabs credits without treating them as dollars", async () => {
    const pricing = createFal({ apiKey: "test", baseURL: `${url}/v1` });
    const restore = installFalDynamicEstimator(pricing.v1.models.pricing.estimate);
    try {
      const fal = providerUsageFetch("fal");
      reply = { request_id: "units", status: "IN_QUEUE" };
      await scoped(() => fal(`${url}/fal-ai/flux-2-flex`, { method: "POST", body: JSON.stringify({ prompt: "test" }) }));
      reply = { images: [] };
      headers = { "x-fal-billable-units": "7" };
      for (let i = 0; i < 2; i++) await scoped(() => fal(`${url}/fal-ai/flux-2-flex/requests/units`));
      expect(engine.usage.find("fal", "units")).toMatchObject({ costUsd: 0.21, basis: "estimated", units: 7, unit: "billable-units" });
      expect(pricingRequests).toContainEqual({ estimate_type: "unit_price", endpoints: { "fal-ai/flux-2-flex": { unit_quantity: 7 } } });
      headers = { "character-cost": "5" };
      const elevenlabs = createElevenLabs({ apiKey: "test", baseURL: url });
      await scoped(() => elevenlabs.v1.textToSpeech("voice", { text: "Hello", model_id: "eleven_multilingual_v2" }));
      expect(engine.usage.recent(1)[0]).toMatchObject({ costUsd: null, basis: "unknown", units: 5, unit: "credits" });
      expect(engine.usage.recent(1)[0]?.warnings.join(" ")).toContain("plan");
    } finally { restore(); }
  });

  it("records measured tokens and estimates once per provider response, without saving prompts", async () => {
    const provider = createOpenAi({ apiKey: "test", baseURL: `${url}/v1` });
    await scoped(() => provider.post.v1.responses({ model: "gpt-4o", input: "private prompt" }));
    await scoped(() => provider.post.v1.responses({ model: "gpt-4o", input: "private prompt" }));
    expect(engine.usage.summary().totals).toMatchObject({ count: 1, inputTokens: 1200, outputTokens: 300, cachedTokens: 200, estimatedUsd: 0.00575, unpriced: 0 });
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

  it("prices Suno music and sounds by endpoint and settles them from record-info polls without adding spend", async () => {
    const kie = providerUsageFetch("kie");
    async function submit(path: string, taskId: string, body: Record<string, unknown>) {
      reply = { code: 200, msg: "success", data: { taskId } };
      await scoped(() => kie(`${url}${path}`, { method: "POST", body: JSON.stringify(body) }), engine, "generate_media");
    }
    async function poll(taskId: string, data: Record<string, unknown>) {
      reply = { code: 200, msg: "success", data: { taskId, ...data } };
      await scoped(() => kie(`${url}/api/v1/generate/record-info?taskId=${taskId}`), engine, "generate_media");
    }
    await submit("/api/v1/generate", "suno-music", { prompt: "a calm piano loop", model: "V5_5", instrumental: true, customMode: false, callBackUrl: "https://callback.test" });
    await submit("/api/v1/generate/sounds", "suno-sounds", { prompt: "rain on a tin roof", model: "V5" });
    expect(engine.usage.find("kie", "suno-music")).toMatchObject({
      model: "V5_5", activity: "audio", status: "pending", basis: "estimated", costUsd: 0.06, units: 1,
      rateSource: "https://kie.ai/suno-api?model=ai-music-api%2Fgenerate",
    });
    expect(engine.usage.find("kie", "suno-sounds")).toMatchObject({
      model: "V5", activity: "audio", status: "pending", basis: "estimated", costUsd: 0.0125, units: 1,
      rateSource: "https://kie.ai/suno-api?model=ai-music-api%2Fsounds",
    });
    expect(engine.usage.summary().totals).toMatchObject({ count: 2, pendingCount: 2, estimatedUsd: 0 });
    expect(engine.usage.summary().totals.pendingUsd).toBeCloseTo(0.0725);
    for (const status of ["PENDING", "TEXT_SUCCESS"]) {
      await poll("suno-music", { status });
      expect(engine.usage.find("kie", "suno-music")?.status).toBe("pending");
    }
    await poll("suno-music", { status: "FIRST_SUCCESS", response: { sunoData: [{ audioUrl: "https://example.test/track.mp3" }] } });
    await poll("suno-sounds", { status: "GENERATE_AUDIO_FAILED", errorMessage: "Audio generation failed" });
    expect(engine.usage.find("kie", "suno-music")).toMatchObject({ status: "completed", costUsd: 0.06 });
    expect(engine.usage.find("kie", "suno-sounds")).toMatchObject({ status: "failed", costUsd: 0.0125 });
    expect(engine.usage.summary().totals).toMatchObject({ count: 2, pendingCount: 0, pendingUsd: 0, estimatedUsd: 0.06 });
  });

  it("keeps KIE createTask and Veo usage pending until their record-info polls settle it", async () => {
    const kie = providerUsageFetch("kie");
    async function submit(path: string, taskId: string, body: Record<string, unknown>) {
      reply = { code: 200, msg: "success", data: { taskId } };
      await scoped(() => kie(`${url}${path}`, { method: "POST", body: JSON.stringify(body) }), engine, "generate_media");
    }
    async function poll(path: string, taskId: string, data: Record<string, unknown>) {
      reply = { code: 200, msg: "success", data: { taskId, ...data } };
      await scoped(() => kie(`${url}${path}?taskId=${taskId}`), engine, "generate_media");
    }
    const tasks = ["image-done", "image-failed", "veo-done", "veo-failed"];
    for (const taskId of tasks.slice(0, 2)) await submit("/api/v1/jobs/createTask", taskId, { model: "qwen2/text-to-image", input: { prompt: "test" } });
    for (const taskId of tasks.slice(2)) await submit("/api/v1/veo/generate", taskId, { model: "veo3_fast", prompt: "test" });
    for (const state of ["waiting", "queuing", "generating"]) {
      for (const taskId of tasks.slice(0, 2)) await poll("/api/v1/jobs/recordInfo", taskId, { state });
    }
    for (const taskId of tasks.slice(2)) await poll("/api/v1/veo/record-info", taskId, { successFlag: 0 });
    expect(tasks.map((taskId) => engine.usage.find("kie", taskId)?.status)).toEqual(["pending", "pending", "pending", "pending"]);
    expect(engine.usage.summary().totals).toMatchObject({ count: 4, pendingCount: 4, estimatedUsd: 0 });
    await poll("/api/v1/jobs/recordInfo", "image-done", { state: "success" });
    await poll("/api/v1/jobs/recordInfo", "image-failed", { state: "fail", failMsg: "Generation failed" });
    await poll("/api/v1/veo/record-info", "veo-done", { successFlag: 1 });
    await poll("/api/v1/veo/record-info", "veo-failed", { successFlag: 3 });
    expect(tasks.map((taskId) => engine.usage.find("kie", taskId)?.status)).toEqual(["completed", "failed", "completed", "failed"]);
    expect(engine.usage.find("kie", "veo-done")).toMatchObject({ model: "veo3_fast", activity: "video", costUsd: 0.3 });
    const totals = engine.usage.summary().totals;
    expect(totals).toMatchObject({ count: 4, pendingCount: 0, pendingUsd: 0 });
    expect(totals.estimatedUsd).toBeCloseTo(0.328);
  });


  it("records fal Alibaba routes and resolves polling by request id rather than output id", async () => {
    const transport = providerUsageFetch("fal");
    reply = { request_id: "fal-alibaba", status: "IN_QUEUE" };
    await scoped(() => transport(`${url}/alibaba/qwen-image-3/edit`, { method: "POST", body: JSON.stringify({ prompt: "test", image_urls: ["https://example.test/image.png"] }) }));
    reply = { id: "output-id", usage: { cost: 0.3 } };
    await scoped(() => transport(`${url}/alibaba/qwen-image-3/requests/fal-alibaba`));
    expect(engine.usage.summary().totals).toMatchObject({ count: 1, pendingCount: 0, reportedUsd: 0.3, unpriced: 0 });
    expect(engine.usage.recent()[0]?.model).toBe("alibaba/qwen-image-3/edit");
  });

  it("records a historical fal average and keeps it when the queue result has no billable units", async () => {
    const restore = installFalDynamicEstimator(async (request) => {
      expect(request).toEqual({
        estimate_type: "historical_api_price",
        endpoints: { "fal-ai/flux-2-flex": { call_quantity: 1 } },
      });
      return { total_cost: 0.42, currency: "USD" };
    });
    try {
      const transport = providerUsageFetch("fal");
      reply = { request_id: "fal-flex", status: "IN_QUEUE" };
      await scoped(() => transport(`${url}/fal-ai/flux-2-flex`, { method: "POST", body: JSON.stringify({ prompt: "a fox" }) }));
      expect(engine.usage.recent()[0]).toMatchObject({
        model: "fal-ai/flux-2-flex",
        costUsd: 0.42,
        estimateUsd: 0.42,
        estimateSource: "fal-historical-average",
        basis: "estimated",
        status: "pending",
        pricingVersion: expect.stringContaining("fal-historical"),
      });
      expect(engine.usage.recent()[0]?.warnings.join(" ")).toContain("historical average per call");
      expect(engine.usage.summary().totals.unpriced).toBe(0);
      expect(engine.usage.rollup().totals.unestimated).toBe(0);
      reply = { status: "COMPLETED", request_id: "fal-flex" };
      await scoped(() => transport(`${url}/fal-ai/flux-2-flex/requests/fal-flex/status`));
      expect(engine.usage.find("fal", "fal-flex")).toMatchObject({
        costUsd: 0.42,
        estimateUsd: 0.42,
        estimateSource: "fal-historical-average",
        basis: "estimated",
        status: "completed",
      });
    } finally {
      restore();
    }
  });

  it("keeps the H3 Max Extend historical quote in estimateUsd after billable units replace the pending cost", async () => {
    const requests: Array<{ estimate_type: string; quantity: number }> = [];
    const restore = installFalDynamicEstimator(async (request) => {
      const priced = request.endpoints["minimax/h3-max/extend-video"];
      const quantity = priced && "unit_quantity" in priced ? priced.unit_quantity : priced && "call_quantity" in priced ? priced.call_quantity : 0;
      requests.push({ estimate_type: request.estimate_type, quantity });
      return { total_cost: request.estimate_type === "unit_price" ? quantity * 0.05 : 0.32, currency: "USD" };
    });
    try {
      const provider = createFal({ apiKey: "test", queueBaseURL: url });
      for (const duration of [5, 15]) {
        const requestId = `fal-extend-${duration}`;
        reply = { request_id: requestId, status: "IN_QUEUE" };
        headers = {};
        await scoped(() => provider.post.v1.queue.submit({
          endpoint_id: "minimax/h3-max/extend-video",
          input: { prompt: "keep walking", video_url: "https://example.test/clip.mp4", duration, resolution: "2K" },
        }), engine, "generate_media");
        expect(engine.usage.find("fal", requestId)).toMatchObject({
          model: "minimax/h3-max/extend-video",
          costUsd: 0.32,
          estimateUsd: 0.32,
          estimateSource: "fal-historical-average",
          basis: "estimated",
          status: "pending",
        });
      }
      headers = { "x-fal-billable-units": "96" };
      reply = { status: "COMPLETED", request_id: "fal-extend-15" };
      await scoped(() => provider.v1.queue.result({
        endpoint_id: "minimax/h3-max",
        request_id: "fal-extend-15",
      }), engine, "poll_pending_provider_tasks");
      const settled = engine.usage.find("fal", "fal-extend-15");
      expect(settled).toMatchObject({
        status: "completed",
        estimateUsd: 0.32,
        estimateSource: "fal-historical-average",
        actualBasis: "derived",
      });
      expect(settled?.costUsd).toBeCloseTo(4.8, 5);
      expect(engine.usage.rollup().totals.unestimated).toBe(0);
      expect(engine.usage.rollup().totals.settledEstimateUsd).toBeCloseTo(0.32, 5);
      expect(engine.usage.rollup().totals.pendingEstimateUsd).toBeCloseTo(0.32, 5);
      expect(requests.filter((request) => request.estimate_type === "historical_api_price")).toEqual([
        { estimate_type: "historical_api_price", quantity: 1 },
      ]);
      expect(requests).toContainEqual({ estimate_type: "unit_price", quantity: 96 });
    } finally {
      restore();
      headers = {};
    }
  });

  it("flags a completed fal result that omits billable units as awaiting the bill, then prices a later result that carries them", async () => {
    const requests: Array<{ estimate_type: string; quantity: number }> = [];
    const restore = installFalDynamicEstimator(async (request) => {
      const priced = request.endpoints["minimax/h3-max/extend-video"];
      const quantity = priced && "unit_quantity" in priced ? priced.unit_quantity : priced && "call_quantity" in priced ? priced.call_quantity : 0;
      requests.push({ estimate_type: request.estimate_type, quantity });
      return { total_cost: request.estimate_type === "unit_price" ? quantity * 0.05 : 0.32, currency: "USD" };
    });
    try {
      const provider = createFal({ apiKey: "test", queueBaseURL: url });
      reply = { request_id: "fal-late", status: "IN_QUEUE" };
      headers = {};
      await scoped(() => provider.post.v1.queue.submit({
        endpoint_id: "minimax/h3-max/extend-video",
        input: { prompt: "keep walking", video_url: "https://example.test/clip.mp4", duration: 10, resolution: "2K" },
      }), engine, "generate_media");
      reply = { video: { url: "https://example.test/extended.mp4" } };
      await scoped(() => provider.v1.queue.result({
        endpoint_id: "minimax/h3-max",
        request_id: "fal-late",
      }), engine, "poll_pending_provider_tasks");
      expect(engine.usage.find("fal", "fal-late")).toMatchObject({
        status: "completed",
        basis: "estimated",
        costUsd: 0.32,
        estimateUsd: 0.32,
        estimateSource: "fal-historical-average",
        actualBasis: "none",
        warnings: [FAL_RESULT_OMITTED_UNITS_WARNING],
      });
      expect(engine.usage.rollup().totals).toMatchObject({ count: 1, unsettled: 1, unestimated: 0 });
      headers = { "x-fal-billable-units": "64" };
      await scoped(() => provider.v1.queue.result({
        endpoint_id: "minimax/h3-max",
        request_id: "fal-late",
      }), engine, "poll_pending_provider_tasks");
      const settled = engine.usage.find("fal", "fal-late");
      expect(settled).toMatchObject({
        status: "completed",
        actualBasis: "derived",
        estimateUsd: 0.32,
        estimateSource: "fal-historical-average",
        units: 64,
        unit: "billable-units",
      });
      expect(settled?.costUsd).toBeCloseTo(3.2, 5);
      expect(settled?.warnings ?? []).not.toContain(FAL_RESULT_OMITTED_UNITS_WARNING);
      expect(engine.usage.rollup().totals).toMatchObject({ unsettled: 0, unestimated: 0 });
      expect(engine.usage.rollup().totals.settledEstimateUsd).toBeCloseTo(0.32, 5);
      expect(requests.filter((request) => request.estimate_type === "historical_api_price")).toEqual([
        { estimate_type: "historical_api_price", quantity: 1 },
      ]);
      expect(requests).toContainEqual({ estimate_type: "unit_price", quantity: 64 });
    } finally {
      restore();
      headers = {};
    }
  });

  it("records a completed fal queue request as failed, without its estimate as spend, when its result read answers an error", async () => {
    const restore = installFalDynamicEstimator(async () => ({ total_cost: 0.32, currency: "USD" }));
    try {
      const provider = createFal({ apiKey: "test", queueBaseURL: url });
      const requests = ["fal-rejected", "fal-throttled"];
      for (const request_id of requests) {
        reply = { request_id, status: "IN_QUEUE" };
        await scoped(() => provider.post.v1.queue.submit({
          endpoint_id: "minimax/h3-max/extend-video",
          input: { prompt: "keep walking", video_url: "https://example.test/clip.mp4" },
        }), engine, "generate_media");
        reply = { status: "COMPLETED", request_id };
        await scoped(() => provider.v1.queue.status({ endpoint_id: "minimax/h3-max", request_id }), engine, "poll_pending_provider_tasks");
      }
      expect(requests.map((id) => engine.usage.find("fal", id))).toMatchObject([
        { status: "completed", basis: "estimated", costUsd: 0.32 },
        { status: "completed", basis: "estimated", costUsd: 0.32 },
      ]);
      expect(engine.usage.summary().totals).toMatchObject({ count: 2, pendingCount: 0, estimatedUsd: 0.64 });
      replyStatus = 422;
      reply = { detail: [{ loc: ["body", "video_url"], msg: "Video is longer than the model accepts", type: "value_error" }] };
      await expect(scoped(() => provider.v1.queue.result({ endpoint_id: "minimax/h3-max", request_id: "fal-rejected" }), engine, "poll_pending_provider_tasks"))
        .rejects.toMatchObject({ status: 422 });
      replyStatus = 429;
      reply = { detail: "Too many requests" };
      await expect(scoped(() => provider.v1.queue.result({ endpoint_id: "minimax/h3-max", request_id: "fal-throttled" }), engine, "poll_pending_provider_tasks"))
        .rejects.toMatchObject({ status: 429 });
      expect(requests.map((id) => engine.usage.find("fal", id)?.status)).toEqual(["failed", "completed"]);
      expect(engine.usage.summary().totals).toMatchObject({ count: 2, pendingCount: 0, estimatedUsd: 0.32 });
      const usage = await bookUsageDef(engine).handler({ book_id: engine.book.get().bookId });
      expect(JSON.parse(usage.content[0]!.text).totals).toMatchObject({ estimatedUsd: 0.32, reportedUsd: 0 });
    } finally {
      restore();
    }
  });

  it("settles a fal request whose result read states 0 billable units as not billed, with fal's reason, in cell, run, job and book totals", async () => {
    const estimates: Record<string, unknown>[] = [];
    const restore = installFalDynamicEstimator(async (request) => {
      estimates.push(request);
      return { total_cost: 0.32, currency: "USD" };
    });
    try {
      const provider = createFal({ apiKey: "test", queueBaseURL: url });
      const attribution = { cellId: "cell-extend", runId: "run-extend", jobId: "job-extend" };
      const generation = <T>(operation: () => Promise<T>, name: string) =>
        withBookContext({ bookId: engine.book.get().bookId, engine, operation: name, ...attribution }, operation);
      for (const request_id of ["fal-oversized", "fal-unbilled"]) {
        reply = { request_id, status: "IN_QUEUE" };
        await generation(() => provider.post.v1.queue.submit({
          endpoint_id: "minimax/h3-max/extend-video",
          input: { prompt: "keep walking", video_url: "https://example.test/clip.mp4" },
        }), "generate_media");
        reply = { status: "COMPLETED", request_id };
        await generation(() => provider.v1.queue.status({ endpoint_id: "minimax/h3-max", request_id }), "poll_pending_provider_tasks");
      }
      expect(engine.usage.rollup({ cellId: "cell-extend" }).totals).toMatchObject({ count: 2, unsettled: 2, estimatedUsd: 0.64 });
      headers = { "x-fal-billable-units": "0" };
      replyStatus = 422;
      reply = { detail: [{ loc: ["body", "video_url"], msg: "File size exceeds 52428800 bytes", type: "value_error" }] };
      await expect(generation(() => provider.v1.queue.result({ endpoint_id: "minimax/h3-max", request_id: "fal-oversized" }), "poll_pending_provider_tasks"))
        .rejects.toMatchObject({ status: 422 });
      replyStatus = undefined;
      reply = { video: { url: "https://example.test/extended.mp4" } };
      await generation(() => provider.v1.queue.result({ endpoint_id: "minimax/h3-max", request_id: "fal-unbilled" }), "poll_pending_provider_tasks");
      expect(engine.usage.find("fal", "fal-oversized")).toMatchObject({
        status: "failed", basis: "free", costUsd: 0, units: 0, unit: "billable-units", actualBasis: "derived",
        warnings: ["fal answered HTTP 422 and billed 0 units: video_url: File size exceeds 52428800 bytes"],
      });
      expect(engine.usage.find("fal", "fal-unbilled")).toMatchObject({
        status: "completed", basis: "free", costUsd: 0, units: 0, warnings: ["fal billed 0 units for this request"],
      });
      expect(estimates.map((request) => request.estimate_type)).toEqual(["historical_api_price"]);
      for (const filter of [{ cellId: "cell-extend" }, { runId: "run-extend" }, { jobId: "job-extend" }, {}]) {
        expect(engine.usage.rollup(filter).totals).toMatchObject({ count: 2, unsettled: 0, unpriced: 0, pendingCount: 0, actualUsd: 0, estimatedUsd: 0 });
      }
      const usage = JSON.parse((await bookUsageDef(engine).handler({ book_id: engine.book.get().bookId, scope: { cell_id: "cell-extend" } })).content[0]!.text);
      expect(usage.totals).toMatchObject({ count: 2, unpriced: 0, estimatedUsd: 0, reportedUsd: 0 });
      expect(usage.cell.totals).toMatchObject({ count: 2, unsettled: 0, unpriced: 0 });
    } finally {
      restore();
    }
  });

  it("sends a Request intact and keeps its response readable when garbage collection runs while pricing is pending", async () => {
    const estimateTypes: string[] = [];
    const restore = installFalDynamicEstimator(async (request) => {
      estimateTypes.push(request.estimate_type);
      await collectDiscardedObjects();
      return { total_cost: 0.42, currency: "USD" };
    });
    try {
      const transport = providerUsageFetch("fal");
      const body = JSON.stringify({ prompt: "a fox" });
      reply = { request_id: "fal-collected", status: "IN_QUEUE" };
      headers = { "x-fal-billable-units": "7" };
      const response = await scoped(() => transport(new Request(`${url}/fal-ai/flux-2-flex`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })));
      expect(await response.json()).toEqual(reply);
      expect(receivedBodies).toEqual([body]);
      expect(estimateTypes).toEqual(["historical_api_price", "unit_price"]);
      expect(engine.usage.find("fal", "fal-collected")).toMatchObject({ model: "fal-ai/flux-2-flex", status: "pending" });
    } finally {
      restore();
    }
  });

  it("leaves a dynamic fal request unpriced when the admin estimator is absent", async () => {
    const transport = providerUsageFetch("fal");
    reply = { request_id: "fal-flex", status: "IN_QUEUE" };
    await scoped(() => transport(`${url}/fal-ai/flux-2-flex`, { method: "POST", body: JSON.stringify({ prompt: "a fox" }) }));
    expect(engine.usage.recent()[0]).toMatchObject({ model: "fal-ai/flux-2-flex", costUsd: null, basis: "unknown", status: "pending" });
    expect(engine.usage.summary().totals).toMatchObject({ pendingCount: 1, estimatedUsd: 0 });
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
    expect(engine.usage.summary().totals).toMatchObject({ count: 2, pendingCount: 0, unpriced: 1 });
    expect(engine.usage.find("alibaba", "alibaba-image")?.costUsd).toBeNull();
    expect(engine.usage.find("alibaba", "alibaba-image")?.warnings.join(" ")).toMatch(/scope|baseURL/);
  });

  it("prefers reported charges and treats retries with different response ids as new spend", async () => {
    const provider = createOpenAi({ apiKey: "test", baseURL: `${url}/v1` });
    await scoped(() => provider.post.v1.responses({ model: "gpt-4o", input: "test" }));
    reply = { id: "response-two", usage: { input_tokens: 10, output_tokens: 5, cost_in_usd_ticks: 10_000_000 } };
    await scoped(() => providerUsageFetch("xai")(`${url}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "grok-4", messages: [] }) }));
    expect(engine.usage.summary().totals).toMatchObject({ count: 2, inputTokens: 1210, outputTokens: 305, estimatedUsd: 0.00575, reportedUsd: 0.001 });
  });

  it("returns provider success even when usage cannot be recorded and discloses incomplete accounting", async () => {
    const provider = createOpenAi({ apiKey: "test", baseURL: `${url}/v1` });
    reply = { id: "invalid-usage", output: [], usage: { input_tokens: 1.5, output_tokens: 5 } };
    const response = await scoped(() => provider.post.v1.responses({ model: "gpt-4o", input: "test" }));
    expect(response.id).toBe("invalid-usage");
    const summary = await scoped(() => bookUsageDef(scopedBookEngine).handler({ book_id: engine.book.get().bookId }));
    expect(JSON.parse(summary.content[0]!.text).incomplete).toBe(true);
  });

  it("prices scribe_v2 from a known duration and leaves an unknown duration unpriced", async () => {
    const provider = createElevenLabs({ apiKey: "test", baseURL: url });
    reply = { text: "hi" };
    const file = new Blob([Uint8Array.from([1, 2, 3])], { type: "audio/mpeg" });
    const request = { model_id: "scribe_v2", file };
    await scoped(() => provider.v1.speechToText(request));
    expect(engine.usage.recent(1)[0]).toMatchObject({
      provider: "elevenlabs", model: "scribe_v2", activity: "analysis", basis: "unknown", costUsd: null, status: "completed",
    });
    const created = await engine.artifacts.create("audio", "clip");
    if (!created.ok) throw new Error(created.error.message);
    await engine.metadata.artifacts.write(created.value.artifactId, "generation-cost-hints", { durationSeconds: 4 });
    await withBookContext(
      { bookId: engine.book.get().bookId, engine, operation: "transcribe", artifactId: created.value.artifactId },
      () => provider.v1.speechToText(request),
    );
    expect(engine.usage.recent(1)[0]).toMatchObject({ basis: "estimated", units: 4, unit: "seconds" });
    expect(engine.usage.recent(1)[0]?.costUsd).toBeCloseTo(4 * 0.22 / 3600, 8);
    await withBookContext(
      { bookId: engine.book.get().bookId, engine, operation: "transcribe", artifactId: created.value.artifactId },
      () => withUsageCostHints({ durationSeconds: 10 }, () => provider.v1.speechToText(request)),
    );
    expect(engine.usage.recent(1)[0]).toMatchObject({ basis: "estimated", units: 10, unit: "seconds", warnings: [] });
    expect(engine.usage.recent(1)[0]?.costUsd).toBeCloseTo(10 * 0.22 / 3600, 8);
  });

  it("prices binary speech by characters and excludes calls without a book", async () => {
    const provider = createElevenLabs({ apiKey: "test", baseURL: url });
    await scoped(() => provider.v1.textToSpeech("voice", { text: "Hello", model_id: "eleven_multilingual_v2" }));
    expect(engine.usage.summary().totals).toMatchObject({ count: 1, estimatedUsd: 0.0004, inputTokens: 0, missingTokens: 0 });
    await provider.v1.textToSpeech("voice", { text: "Hello", model_id: "eleven_multilingual_v2" });
    expect(engine.usage.summary().totals.count).toBe(1);
  });

  it("counts billed failed attempts, retains uncertain outcomes, and isolates books", async () => {
    const provider = createOpenAi({ apiKey: "test", baseURL: `${url}/v1` });
    mode = "failure";
    await expect(scoped(() => provider.post.v1.responses({ model: "gpt-4o", input: "test" }))).rejects.toThrow();
    expect(engine.usage.summary().totals).toMatchObject({ inputTokens: 1200, estimatedUsd: 0.00575 });
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

  it("prices realtime cached audio, image and text tokens from complete provider usage", () => {
    recordVoiceUsage(engine, "openai", "gpt-realtime-2.1", "session", "cached", { usage: {
      input_tokens: 100, output_tokens: 10,
      input_token_details: {
        audio_tokens: 60, image_tokens: 10, text_tokens: 30, cached_tokens: 30,
        cached_tokens_details: { audio_tokens: 20, image_tokens: 5, text_tokens: 5 },
      },
      output_token_details: { audio_tokens: 8, text_tokens: 2 },
    } });
    const entry = engine.usage.recent(1)[0];
    expect(entry).toMatchObject({ basis: "estimated", inputTokens: 100, outputTokens: 10, cachedTokens: 30 });
    expect(entry?.costUsd).toBeCloseTo(0.0019775, 10);
    const actual = engine.settings.get<{ usage: Record<string, number> }>("provider-actual:voice:session:cached");
    expect(actual?.usage).toMatchObject({ cacheReadAudioInputTokens: 20, cacheReadImageInputTokens: 5 });
  });

  it("retains incomplete realtime audio details and explains the missing modality counts", () => {
    const model = "gpt-realtime-2.1";
    recordVoiceUsage(engine, "openai", model, "session", "priced", { usage: {
      input_tokens: 30, output_tokens: 10,
      input_token_details: { audio_tokens: 20 }, output_token_details: { audio_tokens: 8 },
    } });
    expect(engine.usage.recent(1)[0]).toMatchObject({ costUsd: null, basis: "unknown", inputTokens: 30, outputTokens: 10 });
    expect(engine.usage.recent(1)[0]?.warnings.join(" ")).toContain("cacheReadAudioInputTokens");
    const actual = engine.settings.get<{ usage: { audioInputTokens: number; audioOutputTokens: number } }>("provider-actual:voice:session:priced");
    expect(actual?.usage).toMatchObject({ audioInputTokens: 20, audioOutputTokens: 8 });
  });

  it("persists each realtime response once and labels missing model rates", () => {
    const response = { status: "cancelled", usage: { input_tokens: 30, output_tokens: 10, input_token_details: { cached_tokens: 5, audio_tokens: 20 } } };
    recordVoiceUsage(engine, "openai", "unknown-realtime-model", "session", "response", response);
    recordVoiceUsage(engine, "openai", "unknown-realtime-model", "session", "response", response);
    expect(engine.usage.summary().totals).toMatchObject({ count: 1, inputTokens: 30, outputTokens: 10, cachedTokens: 5, unpriced: 1 });
    expect(engine.usage.recent()[0]?.status).toBe("cancelled");
    recordTranscriptionUsage(engine, "unknown-transcription-model", "session", "input", { usage: { input_tokens: 20, output_tokens: 5 } });
    expect(engine.usage.summary().totals).toMatchObject({ count: 2, inputTokens: 50, outputTokens: 15, unpriced: 2 });
    expect(engine.usage.summary().groups.map((group) => group.activity)).toEqual(["analysis", "voice"]);
  });
});
