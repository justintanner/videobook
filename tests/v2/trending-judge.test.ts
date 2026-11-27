import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngine, type Engine } from "videobook-engine";
import { withBookContext } from "../../server/src/book-context.js";
import { configureProviderEndpoints } from "../../server/src/media/endpoints.js";
import { testBudget } from "../../server/src/test-budget.js";
import { defaultBrief } from "../../server/src/trending/authenticity.js";
import { fetchCoverImage, type CoverFetchPolicy } from "../../server/src/trending/cover.js";
import { judgeCandidates, RESEARCH_JUDGE_MODEL } from "../../server/src/trending/judge.js";
import { readVerdicts, updateVerdicts, verdictCacheKey } from "../../server/src/trending/ledger.js";
import type { TrendingSchedule } from "../../server/src/trending/types.js";
import { candidate, cutAt, schedule } from "./trending-fixtures.js";

interface CapturedContentPart {
  type: string;
  text?: string;
  image_url?: string;
  detail?: string;
}

interface CapturedRequest {
  model: string;
  instructions: string;
  reasoning?: { effort?: string };
  store?: boolean;
  input: Array<{ role: string; content: CapturedContentPart[] }>;
  text?: {
    format?: {
      type: string;
      name: string;
      strict: boolean;
      schema: Record<string, unknown>;
    };
  };
}

type OpenAiReply = {
  status?: number;
  body?: Record<string, unknown>;
  delayMs?: number;
  onReceive?: (request: CapturedRequest) => void;
};

const authenticSchedule: TrendingSchedule = {
  ...schedule,
  ranking: "authentic",
};

const SAMPLE_WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

function completedResponse(text: string, model = RESEARCH_JUDGE_MODEL): Record<string, unknown> {
  return {
    id: `resp_${Math.random().toString(36).slice(2, 10)}`,
    object: "response",
    created_at: 0,
    status: "completed",
    model,
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    instructions: null,
    previous_response_id: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    store: false,
    tools: [],
    reasoning: { effort: "low" },
    text: { format: { type: "text" } },
    usage: { input_tokens: 900, output_tokens: 80, total_tokens: 980 },
    error: null,
    incomplete_details: null,
    metadata: {},
  };
}

function refusalResponse(reason: string, model = RESEARCH_JUDGE_MODEL): Record<string, unknown> {
  return {
    id: `resp_${Math.random().toString(36).slice(2, 10)}`,
    object: "response",
    created_at: 0,
    status: "completed",
    model,
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "refusal", refusal: reason }],
      },
    ],
    instructions: null,
    previous_response_id: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    store: false,
    tools: [],
    reasoning: { effort: "low" },
    text: { format: { type: "text" } },
    usage: { input_tokens: 500, output_tokens: 20, total_tokens: 520 },
    error: null,
    incomplete_details: null,
    metadata: {},
  };
}

function postTextOf(request: CapturedRequest): string {
  const part = request.input[0]?.content.find((entry) => entry.type === "input_text");
  return part?.text ?? "";
}

function imagePartOf(request: CapturedRequest): CapturedContentPart | undefined {
  return request.input[0]?.content.find((entry) => entry.type === "input_image");
}

function startServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseURL: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

let root: string | undefined;
let engine: Engine | undefined;
let openaiServer: Server | undefined;
let coverServer: Server | undefined;
let coverBaseURL = "";
let restoreEndpoints: () => void = () => undefined;
let capturedRequests: CapturedRequest[] = [];
let inFlight = 0;
let maxInFlight = 0;
let openaiResponder: (request: CapturedRequest, index: number) => OpenAiReply = () => ({
  status: 200,
  body: completedResponse(JSON.stringify({ kind: "candid", fit: 8, why: "Real everyday street moment in Thailand." })),
});

const localCoverPolicy: CoverFetchPolicy = {
  allowHttp: true,
  allowPrivateHosts: true,
  timeoutMs: 2_000,
  maxBytes: 1_500_000,
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trending-judge-"));
  engine = createEngine({ rootDir: root, initialBookName: "tiktok-th-research", durableWrites: false });
  await engine.ready;

  capturedRequests = [];
  inFlight = 0;
  maxInFlight = 0;
  openaiResponder = () => ({
    status: 200,
    body: completedResponse(JSON.stringify({ kind: "candid", fit: 8, why: "Real everyday street moment in Thailand." })),
  });

  const openai = await startServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest;
      const index = capturedRequests.length;
      capturedRequests.push(body);
      const reply = openaiResponder(body, index);
      reply.onReceive?.(body);
      const finish = () => {
        inFlight -= 1;
        if (response.destroyed) return;
        const status = reply.status ?? 200;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(reply.body ?? { error: { message: "Internal error" } }));
      };
      if (reply.delayMs && reply.delayMs > 0) {
        const timer = setTimeout(finish, reply.delayMs);
        response.on("close", () => {
          if (!response.writableEnded) clearTimeout(timer);
        });
      } else {
        finish();
      }
    });
  });
  openaiServer = openai.server;

  const cover = await startServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/ok.webp") {
      response.writeHead(200, { "content-type": "image/webp" });
      response.end(SAMPLE_WEBP);
      return;
    }
    if (path === "/ok.jpg") {
      response.writeHead(200, { "content-type": "image/jpeg; charset=binary" });
      response.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      return;
    }
    if (path === "/404.webp") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    if (path === "/wrong-type.webp") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>nope</html>");
      return;
    }
    if (path === "/oversized-header.webp") {
      const payload = Buffer.alloc(1_600_000, 1);
      response.writeHead(200, { "content-type": "image/webp", "content-length": String(payload.byteLength) });
      response.end(payload);
      return;
    }
    if (path === "/oversized-chunked.webp") {
      response.writeHead(200, { "content-type": "image/webp" });
      const chunk = Buffer.alloc(1024, 2);
      for (let i = 0; i < 6; i += 1) response.write(chunk);
      response.end();
      return;
    }
    if (path === "/slow.webp") {
      const timer = setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, { "content-type": "image/webp" });
        response.end(SAMPLE_WEBP);
      }, 600);
      response.on("close", () => {
        if (!response.writableEnded) clearTimeout(timer);
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  coverServer = cover.server;
  coverBaseURL = cover.baseURL;

  restoreEndpoints = configureProviderEndpoints({ openaiBaseURL: openai.baseURL });
  vi.stubEnv("OPENAI_API_KEY", "offline-openai-key");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  restoreEndpoints();
  restoreEndpoints = () => undefined;
  await closeServer(openaiServer);
  await closeServer(coverServer);
  openaiServer = undefined;
  coverServer = undefined;
  engine?.close();
  engine = undefined;
  if (root) {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    root = undefined;
  }
});

describe("research judge", () => {
  it("sends the expected request shape, cover data URL, post block and effective brief", async () => {
    const longCaption = `${"Street roti vendor in Chiang Mai ".repeat(25)}TAIL_SHOULD_TRUNCATE`;
    const clip = candidate("clip-1", {
      caption: longCaption,
      author: { handle: "streetchef", nickname: "Chef Som", followers: 12345, verified: true },
      music: { title: "Night market sizzle", original: true },
      durationSeconds: 22,
      createdAt: "2026-10-26T00:00:00.000Z",
      metrics: { views: 500_000, likes: 50_000, shares: 10_000, comments: 250, saves: 2_000 },
      feed: "explore:comedy",
      coverUrl: `${coverBaseURL}/ok.webp`,
    });

    const first = await judgeCandidates(engine!, authenticSchedule, [clip], {
      cutAt,
      coverPolicy: localCoverPolicy,
    });
    expect(first.checked).toBe(1);
    expect(first.failed).toBe(0);
    expect(first.verdicts.get("clip-1")).toEqual({
      kind: "candid",
      fit: 8,
      why: "Real everyday street moment in Thailand.",
      cover: true,
    });
    expect(capturedRequests).toHaveLength(1);

    const req = capturedRequests[0];
    expect(RESEARCH_JUDGE_MODEL).toBe("gpt-5.6-sol");
    expect(req.model).toBe(RESEARCH_JUDGE_MODEL);
    expect(req.reasoning).toEqual({ effort: "low" });
    expect(req.store).toBe(false);
    expect(req.text?.format).toEqual({
      type: "json_schema",
      name: "trending_verdict",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: {
            type: "string",
            enum: ["candid", "staged", "ad", "news", "show", "performance", "edit", "animation", "other"],
          },
          fit: { type: "integer", minimum: 0, maximum: 10 },
          why: { type: "string", maxLength: 160 },
        },
        required: ["kind", "fit", "why"],
      },
    });
    expect(req.instructions).toContain("You screen short videos for a researcher who collects real-life clips.");
    expect(req.instructions).toContain(defaultBrief("TH"));

    const image = imagePartOf(req);
    expect(image).toEqual({
      type: "input_image",
      image_url: `data:image/webp;base64,${SAMPLE_WEBP.toString("base64")}`,
      detail: "low",
    });

    const postText = postTextOf(req);
    expect(postText).toContain("<post>");
    expect(postText).toContain("</post>");
    expect(postText).toContain(`caption: ${longCaption.slice(0, 600)}`);
    expect(postText).not.toContain("TAIL_SHOULD_TRUNCATE");
    expect(postText).toContain("author: @streetchef (Chef Som), followers: 12345, verified: yes");
    expect(postText).toContain("sound: Night market sizzle (original sound: yes)");
    expect(postText).toContain("duration: 22 s");
    expect(postText).toContain("posted: 2 days before the cut");
    expect(postText).toContain("views: 500000; like rate: 10.00%; share rate: 2.00%; comment rate: 0.05%; save rate: 0.40%");
    expect(postText).toContain("feed: explore:comedy");

    const customBrief = "Only funny street dogs and cats in Bangkok markets.";
    const customSchedule: TrendingSchedule = {
      ...authenticSchedule,
      criteria: { brief: customBrief },
    };
    const second = await judgeCandidates(engine!, customSchedule, [clip], {
      cutAt,
      coverPolicy: localCoverPolicy,
    });
    expect(second.checked).toBe(1);
    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[1].instructions).toContain(customBrief);
    expect(capturedRequests[1].instructions).not.toContain(defaultBrief("TH"));
  }, testBudget(60_000));

  it("falls back to text-only requests with cover=false when cover fetching fails", async () => {
    expect(await fetchCoverImage("https://127.0.0.1/cover.webp")).toBeUndefined();
    expect(await fetchCoverImage("https://localhost/cover.webp")).toBeUndefined();
    expect(await fetchCoverImage("https://10.0.0.1/cover.webp")).toBeUndefined();
    expect(await fetchCoverImage("https://169.254.169.254/cover.webp")).toBeUndefined();
    expect(await fetchCoverImage("https://[::1]/cover.webp")).toBeUndefined();
    expect(await fetchCoverImage("http://example.com/cover.webp")).toBeUndefined();
    expect(await fetchCoverImage(`${coverBaseURL}/oversized-header.webp`, undefined, {
      allowHttp: true,
      allowPrivateHosts: true,
    })).toBeUndefined();

    const cases: Array<{ id: string; url: string; policy?: CoverFetchPolicy }> = [
      { id: "cover-404", url: `${coverBaseURL}/404.webp`, policy: localCoverPolicy },
      { id: "cover-html", url: `${coverBaseURL}/wrong-type.webp`, policy: localCoverPolicy },
      { id: "cover-oversized", url: `${coverBaseURL}/oversized-chunked.webp`, policy: { ...localCoverPolicy, maxBytes: 2048 } },
      { id: "cover-timeout", url: `${coverBaseURL}/slow.webp`, policy: { ...localCoverPolicy, timeoutMs: 80 } },
      { id: "cover-non-https", url: `${coverBaseURL}/ok.webp`, policy: undefined },
    ];

    for (const item of cases) {
      const beforeCount = capturedRequests.length;
      const result = await judgeCandidates(
        engine!,
        authenticSchedule,
        [candidate(item.id, { coverUrl: item.url })],
        { cutAt, coverPolicy: item.policy },
      );
      expect(result.checked).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.verdicts.get(item.id)?.cover).toBe(false);
      expect(capturedRequests).toHaveLength(beforeCount + 1);
      const latest = capturedRequests.at(-1)!;
      expect(imagePartOf(latest)).toBeUndefined();
      expect(latest.input[0].content).toHaveLength(1);
      expect(latest.input[0].content[0].type).toBe("input_text");
    }
  }, testBudget(60_000));

  it("counts 500s, refusals, bad JSON, missing keys and out-of-range fit as failed and emits one diagnostic", async () => {
    const clips = [
      candidate("fail-500", { caption: "MARKER:fail-500" }),
      candidate("fail-refusal", { caption: "MARKER:fail-refusal" }),
      candidate("fail-json", { caption: "MARKER:fail-json" }),
      candidate("fail-missing", { caption: "MARKER:fail-missing" }),
      candidate("fail-fit-high", { caption: "MARKER:fail-fit-high" }),
      candidate("fail-fit-low", { caption: "MARKER:fail-fit-low" }),
    ];

    openaiResponder = (request) => {
      const text = postTextOf(request);
      if (text.includes("MARKER:fail-500")) return { status: 500, body: { error: { message: "boom" } } };
      if (text.includes("MARKER:fail-refusal")) return { status: 200, body: refusalResponse("Refused") };
      if (text.includes("MARKER:fail-json")) return { status: 200, body: completedResponse("{broken json") };
      if (text.includes("MARKER:fail-missing")) {
        return { status: 200, body: completedResponse(JSON.stringify({ kind: "candid", fit: 8 })) };
      }
      if (text.includes("MARKER:fail-fit-high")) {
        return { status: 200, body: completedResponse(JSON.stringify({ kind: "candid", fit: 11, why: "Too high" })) };
      }
      return { status: 200, body: completedResponse(JSON.stringify({ kind: "candid", fit: -1, why: "Too low" })) };
    };

    const result = await judgeCandidates(engine!, authenticSchedule, clips, {
      cutAt,
      coverPolicy: localCoverPolicy,
    });
    expect(result.verdicts.size).toBe(0);
    expect(result.checked).toBe(6);
    expect(result.failed).toBe(6);

    const diagnostics = engine!.logs.read("trending-judge-failed");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ event: "trending-judge-failed", count: 6 });
  }, testBudget(60_000));

  it("writes attempts before calling OpenAI, skips after two failed attempts, caches hits and re-judges when brief changes", async () => {
    const flaky = candidate("flaky-clip", { caption: "MARKER:flaky" });
    const good = candidate("good-clip", { caption: "MARKER:good", coverUrl: `${coverBaseURL}/ok.jpg` });

    const observedAttemptsDuringCall: Array<{ marker: string; attempts: number | undefined }> = [];
    openaiResponder = (request) => {
      const text = postTextOf(request);
      const store = readVerdicts(engine!);
      if (text.includes("MARKER:flaky")) {
        observedAttemptsDuringCall.push({ marker: "flaky", attempts: store["flaky-clip"]?.attempts });
        return { status: 200, body: completedResponse("not valid json") };
      }
      observedAttemptsDuringCall.push({ marker: "good", attempts: store["good-clip"]?.attempts });
      return {
        status: 200,
        body: completedResponse(JSON.stringify({ kind: "candid", fit: 9, why: "Great market moment." })),
      };
    };

    const run1 = await judgeCandidates(engine!, authenticSchedule, [good, flaky], {
      cutAt,
      coverPolicy: localCoverPolicy,
    });
    expect(run1.checked).toBe(2);
    expect(run1.failed).toBe(1);
    expect(run1.verdicts.get("good-clip")?.fit).toBe(9);
    expect(run1.verdicts.has("flaky-clip")).toBe(false);
    expect(observedAttemptsDuringCall).toEqual(
      expect.arrayContaining([
        { marker: "good", attempts: 1 },
        { marker: "flaky", attempts: 1 },
      ]),
    );
    expect(readVerdicts(engine!)["flaky-clip"]?.attempts).toBe(1);

    const requestsAfterRun1 = capturedRequests.length;
    const run2 = await judgeCandidates(engine!, authenticSchedule, [good, flaky], {
      cutAt,
      coverPolicy: localCoverPolicy,
    });
    expect(run2.checked).toBe(1);
    expect(run2.failed).toBe(1);
    expect(run2.verdicts.get("good-clip")?.fit).toBe(9);
    expect(capturedRequests.length).toBe(requestsAfterRun1 + 1);
    expect(readVerdicts(engine!)["flaky-clip"]?.attempts).toBe(2);
    expect(observedAttemptsDuringCall.at(-1)).toEqual({ marker: "flaky", attempts: 2 });

    const requestsAfterRun2 = capturedRequests.length;
    const run3 = await judgeCandidates(engine!, authenticSchedule, [good, flaky], {
      cutAt,
      coverPolicy: localCoverPolicy,
    });
    expect(run3.checked).toBe(0);
    expect(run3.failed).toBe(0);
    expect(run3.verdicts.get("good-clip")?.fit).toBe(9);
    expect(run3.verdicts.has("flaky-clip")).toBe(false);
    expect(capturedRequests.length).toBe(requestsAfterRun2);

    openaiResponder = () => ({
      status: 200,
      body: completedResponse(JSON.stringify({ kind: "candid", fit: 7, why: "Fits the updated brief." })),
    });
    const updatedBriefSchedule: TrendingSchedule = {
      ...authenticSchedule,
      criteria: { brief: "Updated brief about street food and pets." },
    };
    const run4 = await judgeCandidates(engine!, updatedBriefSchedule, [good, flaky], {
      cutAt,
      coverPolicy: localCoverPolicy,
    });
    expect(run4.checked).toBe(2);
    expect(run4.failed).toBe(0);
    expect(run4.verdicts.get("good-clip")?.fit).toBe(7);
    expect(run4.verdicts.get("flaky-clip")?.fit).toBe(7);
    expect(capturedRequests.length).toBe(requestsAfterRun2 + 2);

    const requestsBeforeClosed = capturedRequests.length;
    const closedRoot = await mkdtemp(join(tmpdir(), "trending-judge-closed-"));
    const closedEngine = createEngine({ rootDir: closedRoot, initialBookName: "closed-book", durableWrites: false });
    await closedEngine.ready;
    const brokenEngine = {
      ...closedEngine,
      settings: {
        ...closedEngine.settings,
        get: closedEngine.settings.get.bind(closedEngine.settings),
        set: () => ({ ok: false as const, error: { code: "STORAGE_ERROR", message: "disk full" } }),
      },
    } as unknown as Engine;
    await expect(
      judgeCandidates(brokenEngine, authenticSchedule, [candidate("write-fail")], {
        cutAt,
        coverPolicy: localCoverPolicy,
      }),
    ).rejects.toThrow("disk full");
    expect(capturedRequests.length).toBe(requestsBeforeClosed);
    closedEngine.close();
    await rm(closedRoot, { recursive: true, force: true });
  }, testBudget(60_000));

  it("caps new checks with judgeLimit without charging cached items and keeps at most 4 in flight", async () => {
    const clips = Array.from({ length: 8 }, (_, index) => candidate(`clip-${index + 1}`));
    await judgeCandidates(engine!, authenticSchedule, clips.slice(0, 2), {
      cutAt,
      coverPolicy: localCoverPolicy,
    });
    expect(capturedRequests).toHaveLength(2);

    capturedRequests = [];
    maxInFlight = 0;
    openaiResponder = () => ({
      status: 200,
      delayMs: 60,
      body: completedResponse(JSON.stringify({ kind: "candid", fit: 8, why: "Authentic street scene." })),
    });

    const limitedSchedule: TrendingSchedule = {
      ...authenticSchedule,
      criteria: { judgeLimit: 5 },
    };
    const result = await judgeCandidates(engine!, limitedSchedule, clips, {
      cutAt,
      coverPolicy: localCoverPolicy,
    });
    expect(result.checked).toBe(5);
    expect(result.failed).toBe(0);
    expect(result.verdicts.size).toBe(7);
    expect(result.verdicts.has("clip-8")).toBe(false);
    expect(capturedRequests).toHaveLength(5);
    expect(maxInFlight).toBe(4);
  }, testBudget(60_000));

  it("makes zero requests without a usable key or when judgeLimit is 0 while returning cached verdicts", async () => {
    const cachedClip = candidate("cached-one");
    const uncachedClip = candidate("uncached-one");
    await judgeCandidates(engine!, authenticSchedule, [cachedClip], {
      cutAt,
      coverPolicy: localCoverPolicy,
    });
    expect(capturedRequests).toHaveLength(1);
    capturedRequests = [];

    vi.stubEnv("OPENAI_API_KEY", "");
    const noKey = await judgeCandidates(engine!, authenticSchedule, [cachedClip, uncachedClip], {
      cutAt,
      coverPolicy: localCoverPolicy,
    });
    expect(noKey.checked).toBe(0);
    expect(noKey.verdicts.get("cached-one")?.fit).toBe(8);
    expect(noKey.verdicts.has("uncached-one")).toBe(false);
    expect(capturedRequests).toHaveLength(0);

    vi.stubEnv("OPENAI_API_KEY", "test-placeholder");
    const testKey = await judgeCandidates(engine!, authenticSchedule, [cachedClip, uncachedClip], {
      cutAt,
      coverPolicy: localCoverPolicy,
    });
    expect(testKey.checked).toBe(0);
    expect(testKey.verdicts.get("cached-one")?.fit).toBe(8);
    expect(capturedRequests).toHaveLength(0);

    vi.stubEnv("OPENAI_API_KEY", "sk-test-placeholder");
    const skTestKey = await judgeCandidates(engine!, authenticSchedule, [cachedClip, uncachedClip], {
      cutAt,
      coverPolicy: localCoverPolicy,
    });
    expect(skTestKey.checked).toBe(0);
    expect(capturedRequests).toHaveLength(0);

    vi.stubEnv("OPENAI_API_KEY", "offline-openai-key");
    const zeroLimit = await judgeCandidates(
      engine!,
      { ...authenticSchedule, criteria: { judgeLimit: 0 } },
      [cachedClip, uncachedClip],
      { cutAt, coverPolicy: localCoverPolicy },
    );
    expect(zeroLimit.checked).toBe(0);
    expect(zeroLimit.verdicts.get("cached-one")?.fit).toBe(8);
    expect(zeroLimit.verdicts.has("uncached-one")).toBe(false);
    expect(capturedRequests).toHaveLength(0);
  }, testBudget(60_000));

  it("stops further batches when the abort signal fires", async () => {
    const clips = Array.from({ length: 8 }, (_, index) => candidate(`abort-${index + 1}`));
    const controller = new AbortController();
    let completedInBatch1 = 0;

    openaiResponder = () => ({
      status: 200,
      onReceive: () => {
        completedInBatch1 += 1;
        if (completedInBatch1 === 4) {
          controller.abort(new Error("stop judge"));
        }
      },
      body: completedResponse(JSON.stringify({ kind: "candid", fit: 8, why: "Clip in batch 1." })),
    });

    const result = await judgeCandidates(engine!, authenticSchedule, clips, {
      cutAt,
      signal: controller.signal,
      coverPolicy: localCoverPolicy,
    });
    expect(capturedRequests).toHaveLength(4);
    expect(result.verdicts.size).toBeLessThanOrEqual(4);
    const stored = readVerdicts(engine!);
    for (let index = 5; index <= 8; index += 1) {
      expect(stored[`abort-${index}`]).toBeUndefined();
    }
  }, testBudget(60_000));

  it("prunes verdict entries older than maxAgeDays + 2 days on write", async () => {
    const brief = defaultBrief("TH");
    const key = verdictCacheKey(brief, RESEARCH_JUDGE_MODEL, "v1");
    const pruneSchedule: TrendingSchedule = {
      ...authenticSchedule,
      criteria: { maxAgeDays: 10 },
    };

    await updateVerdicts(engine!, { maxAgeDays: 100, now: cutAt }, () => ({
      "too-old": {
        key,
        at: "2026-10-15T00:00:00.000Z",
        attempts: 1,
        verdict: { kind: "candid", fit: 9, why: "Old entry.", cover: true },
      },
      "still-fresh": {
        key,
        at: "2026-10-17T00:00:00.000Z",
        attempts: 1,
        verdict: { kind: "candid", fit: 8, why: "Fresh entry.", cover: true },
      },
    }));

    await judgeCandidates(engine!, pruneSchedule, [candidate("brand-new")], {
      cutAt,
      coverPolicy: localCoverPolicy,
    });
    const stored = readVerdicts(engine!);
    expect(stored["too-old"]).toBeUndefined();
    expect(stored["still-fresh"]).toBeDefined();
    expect(stored["brand-new"]?.verdict).toBeDefined();
  }, testBudget(60_000));

  it("records usage on the active book inside withBookContext", async () => {
    const bookId = engine!.book.get().bookId;
    const result = await withBookContext({ bookId, engine: engine! }, () =>
      judgeCandidates(engine!, authenticSchedule, [candidate("u1"), candidate("u2")], {
        cutAt,
        coverPolicy: localCoverPolicy,
      }),
    );
    expect(result.checked).toBe(2);
    expect(result.failed).toBe(0);
    const usageRows = engine!.usage.recent(20).filter((entry) => entry.provider === "openai");
    expect(usageRows).toHaveLength(2);
    for (const row of usageRows) {
      expect(row).toMatchObject({
        provider: "openai",
        model: RESEARCH_JUDGE_MODEL,
        status: "completed",
      });
    }
  }, testBudget(60_000));
});
