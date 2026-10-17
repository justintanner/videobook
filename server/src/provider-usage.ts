import { randomUUID } from "node:crypto";
import { createCost, PRICING, PRICING_AS_OF } from "@apicity/cost";
import type { EstimateRequest, ModelPricing, CostHints } from "@apicity/cost";
import type { Engine, UsageEntry, UsageInput } from "videobook-engine";
import { currentBookContext } from "./book-context.js";

type Provider = "openai" | "xai" | "kie" | "fal" | "googleflow" | "alibaba" | "elevenlabs";
type RecordValue = Record<string, unknown>;
type Price = Pick<UsageEntry, "costUsd" | "basis" | "rateSource" | "pricingVersion" | "warnings" | "units" | "unit">;
const incomplete = new WeakSet<Engine>();
const cost = createCost();

function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeRecord(engine: Engine, entry: UsageInput): void {
  try {
    const result = engine.usage.record(entry);
    if (result.ok) return;
  } catch { void 0; }
  incomplete.add(engine);
  try { engine.settings.set("usage-incomplete", true); } catch { void 0; }
}

export function usageIncomplete(engine: Engine): boolean {
  const scoped = currentBookContext()?.engine ?? engine;
  return incomplete.has(scoped) || scoped.settings.get<boolean>("usage-incomplete") === true;
}

export async function settleFinishedUsage(engine: Engine): Promise<void> {
  const pending = engine.usage.recent(200).filter((entry): entry is UsageEntry & { externalId: string; artifactId: string } =>
    entry.status === "pending" && entry.externalId !== null && entry.artifactId !== null);
  for (const entry of pending) {
    const task = engine.jobs.pending.findByExternalId(entry.externalId);
    if (!task.ok || task.value) continue;
    const status = await engine.status.get(entry.artifactId);
    if (!status.ok) continue;
    if (status.value === "ready") safeRecord(engine, { ...entry, status: "completed" });
    else if (status.value === "error") safeRecord(engine, { ...entry, status: "failed" });
  }
}

function reportedTokens(value: unknown): Pick<UsageEntry, "inputTokens" | "outputTokens" | "cachedTokens"> {
  const usage = object(value);
  const inputTokens = number(usage.input_tokens) ?? number(usage.prompt_tokens) ?? number(usage.inputTokens);
  const outputTokens = number(usage.output_tokens) ?? number(usage.completion_tokens) ?? number(usage.outputTokens);
  const details = object(usage.input_tokens_details ?? usage.prompt_tokens_details ?? usage.input_token_details);
  const cachedTokens = number(details.cached_tokens) ?? number(usage.cached_tokens);
  return { inputTokens, outputTokens, cachedTokens: cachedTokens !== null && inputTokens !== null ? Math.min(cachedTokens, inputTokens) : cachedTokens };
}

function rateFor(provider: Provider, model: string): ModelPricing | undefined {
  const rates = PRICING[provider] as Record<string, ModelPricing> | undefined;
  return rates?.[model];
}

function unknownPrice(warnings = ["Price unavailable for this model"]): Price {
  return { costUsd: null, basis: "unknown", rateSource: null, pricingVersion: `apicity-0.15.0:${PRICING_AS_OF}`, warnings, units: null, unit: null };
}

function tokenPrice(provider: Provider, model: string, tokens: ReturnType<typeof reportedTokens>): Price {
  const rate = rateFor(provider, model);
  if (rate?.kind !== "tokens" || tokens.inputTokens === null || tokens.outputTokens === null) return unknownPrice();
  const cached = tokens.cachedTokens ?? 0;
  const usd = ((tokens.inputTokens - cached) * rate.rate.input + cached * (rate.rate.cacheRead ?? rate.rate.input) + tokens.outputTokens * rate.rate.output) / 1e6;
  return { ...unknownPrice([]), costUsd: usd, basis: "estimated", rateSource: rate.source.url, unit: "tokens", units: tokens.inputTokens + tokens.outputTokens };
}

function priceRequest(provider: Provider, model: string, payload: RecordValue, endpoint: string, hints?: CostHints): Price {
  try {
    const request: EstimateRequest = { provider, payload, ...(provider === "fal" ? { endpoint } : {}), ...(hints ? { costHints: hints } : {}) };
    const estimate = cost.estimate(request);
    if (estimate.warnings.length || estimate.source === "tokens-heuristic+table") return unknownPrice(estimate.warnings.length ? estimate.warnings : ["Waiting for reported token usage"]);
    return {
      ...unknownPrice([]), costUsd: estimate.usd, basis: estimate.source === "free" ? "free" : "estimated",
      rateSource: rateFor(provider, model)?.source.url ?? null, pricingVersion: `apicity-0.15.0:${estimate.rateAsOf}`,
      units: estimate.breakdown.units ?? null, unit: estimate.breakdown.unit ?? null,
    };
  } catch { return unknownPrice(); }
}

function activityFor(model: string, path: string, operation = ""): UsageEntry["activity"] {
  if (/\/(responses|completions)$/u.test(path) && /chat|rewrite_prompt/u.test(operation)) return "chat";
  if (/transcrib|speech.to.text|analy|describe|tag_|rename|suggest|translate|vision|image.subjects|regions|verify/iu.test(`${operation} ${path}`)) return "analysis";
  if (/video|veo|wan\/|kling|seedance|happyhorse|lipsync/iu.test(`${model} ${path}`)) return "video";
  if (/audio|speech|music|sound|sfx|suno|vocal/iu.test(`${model} ${path}`)) return "audio";
  if (/image|banana|seedream|qwen|flux|ideogram/iu.test(`${model} ${path}`)) return "images";
  return "analysis";
}

function isBillable(provider: Provider, path: string, method: string): boolean {
  if (method !== "POST") return false;
  if (provider === "openai" || provider === "xai") return /\/(responses|chat\/completions|images\/(generations|edits)|videos\/(generations|edits|extensions)|audio\/(speech|transcriptions|translations)|embeddings|tts|stt)$/u.test(path);
  if (provider === "kie") return /\/(createTask|veo\/(generate|extend))$/u.test(path);
  if (provider === "fal") return /^\/(fal-ai|alibaba)\//u.test(path) && !/\/requests\//u.test(path);
  if (provider === "alibaba") return path.includes("/services/aigc/");
  if (provider === "elevenlabs") return /\/(text-to-speech|speech-to-text|speech-to-speech|sound-generation|audio-isolation|music)(\/|$)/u.test(path);
  return /\/(videos|images)(\/|$)/u.test(path);
}

async function payloadOf(input: RequestInfo | URL, init?: RequestInit): Promise<RecordValue> {
  const body = init?.body;
  if (typeof body === "string") {
    try { return object(JSON.parse(body)); } catch { return {}; }
  }
  if (body instanceof FormData) return Object.fromEntries([...body.entries()].filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  if (input instanceof Request && input.headers.get("content-type")?.includes("application/json")) {
    try { return object(await input.clone().json()); } catch { return {}; }
  }
  return {};
}

function remoteId(body: RecordValue, url: URL, method: string): string | null {
  const data = object(body.data);
  const output = object(body.output);
  const pathId = url.searchParams.get("taskId") ?? url.searchParams.get("task_id")
    ?? (/\/(requests|tasks|jobs|videos)\/([^/]+)(?:\/status)?$/u.exec(url.pathname)?.[2] ?? null);
  if (method === "GET" && pathId) return decodeURIComponent(pathId);
  return text(data.taskId) ?? text(data.task_id) ?? text(body.request_id) ?? text(body.jobid) ?? text(body.jobId) ?? text(body.job_id)
    ?? text(output.task_id) ?? text(body.id);
}

function responseStatus(body: RecordValue, accepted: boolean): UsageEntry["status"] {
  const data = object(body.data);
  const output = object(body.output);
  const state = String(body.status ?? data.state ?? data.status ?? output.task_status ?? "").toLowerCase();
  if (body.error || data.failCode || (typeof body.code === "number" && body.code >= 400) || data.successFlag === 2 || ["failed", "fail", "error"].includes(state)) return "failed";
  if (["cancelled", "canceled"].includes(state)) return "cancelled";
  if (state === "uncertain" || state === "expired") return "uncertain";
  if (data.successFlag === 1 || ["success", "succeeded", "completed", "done"].includes(state)) return "completed";
  if (["created", "pending", "queued", "in_queue", "running", "in_progress", "processing", "started", "waiting"].includes(state)) return "pending";
  return accepted ? "pending" : "completed";
}

function usageOf(body: RecordValue): RecordValue {
  return object(body.usage ?? object(body.data).usage ?? object(body.output).usage ?? object(body.response).usage);
}

function observedPatch(provider: Provider, entry: UsageEntry | UsageInput, body: RecordValue, status: UsageEntry["status"]): Partial<UsageEntry> {
  const usage = usageOf(body);
  const reported = reportedTokens(usage);
  const tokens = {
    inputTokens: reported.inputTokens ?? entry.inputTokens ?? null,
    outputTokens: reported.outputTokens ?? entry.outputTokens ?? null,
    cachedTokens: reported.cachedTokens ?? entry.cachedTokens ?? null,
  };
  const ticks = provider === "xai" ? number(usage.cost_in_usd_ticks) : null;
  const reportedUsd = number(usage.cost_usd) ?? number(body.cost_usd) ?? number(usage.cost_in_usd) ?? (ticks === null ? null : ticks / 1e10);
  const hasTokens = reported.inputTokens !== null || reported.outputTokens !== null;
  const price = reportedUsd !== null
    ? { costUsd: reportedUsd, basis: "reported" as const, warnings: [] }
    : entry.tokenBased && hasTokens ? tokenPrice(provider, entry.model, tokens) : {};
  return { status, ...(hasTokens ? tokens : {}), ...price };
}

async function costHints(engine: Engine, artifactId?: string): Promise<CostHints | undefined> {
  if (!artifactId) return undefined;
  const result = await engine.metadata.artifacts.read<RecordValue>(artifactId, "generation-cost-hints");
  if (!result.ok) return undefined;
  const hints = result.value;
  const durationSeconds = number(hints.durationSeconds) ?? number(hints.duration);
  const inputDurationSeconds = number(hints.inputDurationSeconds) ?? number(hints.inputDuration);
  return { ...(durationSeconds !== null ? { durationSeconds } : {}), ...(inputDurationSeconds !== null ? { inputDurationSeconds } : {}) };
}

export function providerUsageFetch(provider: Provider, transport: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const context = currentBookContext();
    if (!context) return transport(input, init);
    const engine = context.engine;
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const billable = isBillable(provider, url.pathname, method);
    let entry: UsageInput | null = null;
    if (billable) {
      const payload = await payloadOf(input, init);
      const endpoint = url.pathname.replace(/^\//u, "");
      const model = text(payload.model) ?? text(payload.model_id) ?? (provider === "fal" ? endpoint : endpoint.split("/").slice(-2).join("/"));
      let hints: CostHints | undefined;
      try { hints = await costHints(engine, context.artifactId); } catch { void 0; }
      const activity = activityFor(model, url.pathname, context.operation);
      entry = {
        id: randomUUID(), provider, model, activity, status: "pending",
        tokenBased: /\/(responses|completions|embeddings)$/u.test(url.pathname) || rateFor(provider, model)?.kind === "tokens",
        operation: context.operation ?? null, artifactId: context.artifactId ?? null,
        ...priceRequest(provider, model, payload, endpoint, hints),
      };
      safeRecord(engine, entry);
    }
    let response: Response;
    try { response = await transport(input, init); }
    catch (error) {
      if (entry) safeRecord(engine, { ...entry, status: "uncertain", basis: "unknown", warnings: ["Provider outcome unavailable"] });
      throw error;
    }
    try {
      const json = response.headers.get("content-type")?.includes("json");
      const body = json ? object(await response.clone().json()) : {};
      const externalId = remoteId(body, url, method);
      if (entry) {
        const accepted = !!externalId && (provider === "googleflow" ? !!body.jobid || response.status === 201 : provider === "kie" || provider === "fal" || /videos|tasks/u.test(url.pathname) || !!object(body.output).task_id);
        const status = response.ok ? responseStatus(body, accepted) : "failed";
        safeRecord(engine, { ...entry, ...(externalId ? { externalId } : {}), ...observedPatch(provider, entry, body, status) });
      } else if (method === "GET" && externalId && response.ok && json) {
        const existing = engine.usage.find(provider, externalId);
        if (existing) {
          const status = responseStatus(body, /\/status$/u.test(url.pathname));
          safeRecord(engine, { ...existing, ...observedPatch(provider, existing, body, status) });
        }
      }
    } catch {
      if (entry) safeRecord(engine, { ...entry, status: "uncertain", basis: "unknown", warnings: ["Provider usage unavailable"] });
    }
    return response;
  };
}

export function recordVoiceUsage(engine: Engine, provider: "openai" | "xai", model: string, sessionId: string, responseId: string, response: unknown): void {
  const body = object(response);
  const entry: UsageInput = {
    id: `voice:${sessionId}:${responseId}`, externalId: `voice:${sessionId}:${responseId}`,
    provider, model, activity: "voice", tokenBased: true,
    ...unknownPrice(),
  };
  safeRecord(engine, { ...entry, ...observedPatch(provider, entry, body, responseStatus(body, false)) });
}

export function recordTranscriptionUsage(engine: Engine, model: string, sessionId: string, itemId: string, event: unknown): void {
  const body = object(event);
  const entry: UsageInput = {
    id: `transcription:${sessionId}:${itemId}`, externalId: `transcription:${sessionId}:${itemId}`,
    provider: "openai", model, activity: "analysis", tokenBased: true, ...unknownPrice(),
  };
  safeRecord(engine, { ...entry, ...observedPatch("openai", entry, body, responseStatus(body, false)) });
}
