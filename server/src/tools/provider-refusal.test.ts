import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { createOpenAi, createXai } from "../usage-providers.js";
import { buildIntelligenceResponses, intelligenceRequest } from "../openai-intelligence.js";
import { ProviderRefusalError } from "../provider-refusal.js";
import { configureProviderEndpoints } from "../media/endpoints.js";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import { writeTaggingSettings } from "../tag-settings.js";
import { testBudget } from "../test-budget.js";

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const REASON = "This request was declined.";

describe("structured text provider refusals over HTTP", () => {
  let server: Server;
  let baseURL: string;
  let requests: Array<{ path: string; body: Record<string, unknown> }>;
  let mode: "refusal" | "text" | "error";
  let root: string;
  let engine: Engine;
  let client: Client;
  let restoreEndpoints: () => void;
  let savedKey: string | undefined;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push({ path: req.url!, body });
      res.writeHead(mode === "error" ? 400 : 200, { "content-type": "application/json" });
      if (mode === "error") {
        res.end(JSON.stringify({ error: { message: "Invalid input", type: "invalid_request_error", code: "invalid_input" } }));
        return;
      }
      const common = { id: "resp_refusal", model: body.model, created: 1, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
      res.end(JSON.stringify(req.url!.endsWith("/chat/completions") ? {
        ...common, object: "chat.completion",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: mode === "text" ? "normal output" : null, refusal: mode === "refusal" ? REASON : null } }],
      } : {
        ...common, object: "response", created_at: 1, status: "completed",
        output: [{ type: "message", id: "msg_refusal", role: "assistant", status: "completed", content: mode === "refusal"
          ? [{ type: "refusal", refusal: REASON }]
          : [{ type: "output_text", text: "normal output", annotations: [] }] }],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    requests = [];
    mode = "refusal";
    savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "offline-refusal-key";
    restoreEndpoints = configureProviderEndpoints({ openaiBaseURL: baseURL });
    root = await mkdtemp(join(tmpdir(), "videobook-text-refusal-"));
    engine = createEngineForTest(join(root, "book"));
    client = await createTestClient(join(root, "book"));
    writeTaggingSettings(engine, { analysisOnNewAssets: false });
  });

  afterEach(async () => {
    await client.close();
    restoreEndpoints();
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  function call(provider: "openai" | "xai", api: "responses" | "chat"): Promise<unknown> {
    const options = { apiKey: "offline-refusal-key", baseURL };
    const model = provider === "openai" ? "gpt-5.6-sol" : "grok-4";
    const sdk = provider === "openai" ? createOpenAi(options) : createXai(options);
    expect(sdk.post.v1.responses.schema).toBeDefined();
    expect(sdk.post.v1.responses.compact).toBeTypeOf("function");
    return api === "responses"
      ? sdk.post.v1.responses({ model, input: "a test request" })
      : sdk.post.v1.chat.completions({ model, messages: [{ role: "user", content: "a test request" }] });
  }

  it.each([
    ["openai", "responses"], ["openai", "chat"], ["xai", "responses"], ["xai", "chat"],
  ] as const)("preserves a %s %s refusal as a named model error", async (provider, api) => {
    await expect(call(provider, api)).rejects.toMatchObject({
      name: "ProviderRefusalError", status: 200,
      refusal: { failCode: "content_policy_violation", categories: [], message: expect.stringContaining(REASON) },
      message: expect.stringMatching(provider === "openai" ? /GPT.*refused this request/iu : /Grok.*refused this request/iu),
    });
    expect(requests).toHaveLength(1);
  });

  it.each(["openai", "xai"] as const)("preserves normal %s text and ordinary HTTP errors", async (provider) => {
    mode = "text";
    expect(await call(provider, "responses")).toMatchObject({ output: [{ content: [{ type: "output_text", text: "normal output" }] }] });
    expect(await call(provider, "chat")).toMatchObject({ choices: [{ message: { content: "normal output", refusal: null } }] });
    mode = "error";
    await expect(call(provider, "responses")).rejects.not.toBeInstanceOf(ProviderRefusalError);
    await expect(call(provider, "chat")).rejects.toMatchObject({ status: 400 });
  });

  it("does not retry a completed refusal through the intelligence retry wrapper", async () => {
    const responses = buildIntelligenceResponses("offline-refusal-key", { baseURL });
    await expect(responses(intelligenceRequest({ input: "a test request" }))).rejects.toBeInstanceOf(ProviderRefusalError);
    expect(requests).toHaveLength(1);
  });

  it("returns the refusal through chat without routing or retrying it", async () => {
    const result = await client.callTool({ name: "chat", arguments: { book_id: engine.book.get().bookId, prompt: "Please consider this request" } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("refused this request");
    expect(text).toContain(REASON);
    expect(text).not.toContain("Routing failed");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.model).toBe("gpt-6-astra");
  });

  it("persists the same refusal shape when an image analysis job fails", async () => {
    const source = value(await engine.artifacts.create("image", "source")).artifactId;
    value(await engine.files.write(source, "original.png", await sharp({ create: { width: 16, height: 16, channels: 3, background: "green" } }).png().toBuffer()));
    const result = await client.callTool({ name: "describe_image", arguments: { book_id: engine.book.get().bookId, asset_id: source } });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { job_id: number; script_asset_id: string };
    await expect.poll(() => engine.jobs.queue.get(payload.job_id), { timeout: testBudget(10_000) }).toMatchObject({ state: "failed", error: { message: expect.stringContaining("refused this request") } });
    const failure = value(engine.jobs.failures.read(payload.script_asset_id));
    expect(failure).toMatchObject({ failCode: "content_policy_violation", message: expect.stringContaining(REASON) });
    expect(value(await engine.metadata.artifacts.read(payload.script_asset_id, "provider-refusal")))
      .toEqual({ failCode: "content_policy_violation", categories: [], message: failure!.message });
    expect(requests).toHaveLength(1);
    expect(engine.usage.recent(10).find((entry) => entry.provider === "openai"))
      .toMatchObject({ status: "completed", inputTokens: 10, outputTokens: 2 });
  });
});
