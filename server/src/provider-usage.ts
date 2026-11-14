import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createCost, extractActual, mergeActuals, isFalDynamicPricingEndpoint, PRICING, PRICING_AS_OF } from "@apicity/cost";
import type { CostEstimate, EstimateRequest, ModelPricing, CostHints, CostActual, ProviderExchange } from "@apicity/cost";
import type { Engine, UsageEntry, UsageInput } from "videobook-engine";
import { modelEntry } from "./media/catalog.js";
import type { Media } from "./media/types.js";
import {
  estimateFalRequest,
  FAL_HISTORICAL_ESTIMATE_SOURCE,
  historicalAverageWarnings,
  LOWER_BOUND_ESTIMATE_SOURCE,
  lowerBoundWarnings,
} from "./media/cost.js";
import { falErrorDetail, falRefusalCategories } from "./jobs/_fal-shared.js";
import { currentBookContext } from "./book-context.js";
import { installedPackageVersion } from "./package-version.js";
import { httpDotPath, usageQuote, type UsageQuote } from "./usage-quote.js";

const COST_PACKAGE_VERSION = installedPackageVersion("@apicity/cost");

type Provider = "openai" | "xai" | "kie" | "fal" | "alibaba" | "elevenlabs" | "machgen" | "wavespeed";
type RecordValue = Record<string, unknown>;
type Price = Pick<UsageEntry, "costUsd" | "basis" | "rateSource" | "pricingVersion" | "warnings" | "units" | "unit">;
const incomplete = new WeakSet<Engine>();
const cost = createCost();
const usageCostHints = new AsyncLocalStorage<CostHints>();
const quotedEstimates = new AsyncLocalStorage<UsageQuote>();
const clonesHeldForBody = new WeakMap<ReadableStream<Uint8Array>, Request | Response>();

function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function markIncomplete(engine: Engine): void {
  incomplete.add(engine);
  try { engine.settings.set("usage-incomplete", true); } catch { void 0; }
}

function safeRecord(engine: Engine, entry: UsageInput): void {
  try {
    const result = engine.usage.record(entry);
    if (result.ok) return;
  } catch { void 0; }
  markIncomplete(engine);
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

function rateFor(provider: Provider, model: string): ModelPricing | undefined {
  const rates = PRICING[provider] as Record<string, ModelPricing> | undefined;
  return rates?.[model];
}

function unknownPrice(warnings = ["Price unavailable for this model"]): Price {
  return { costUsd: null, basis: "unknown", rateSource: null, pricingVersion: `apicity-${COST_PACKAGE_VERSION}:${PRICING_AS_OF}`, warnings, units: null, unit: null };
}

type PricedRequest = Price & { quote: UsageQuote | null };

function warnedQuoteSource(warnings: readonly string[]): string | null {
  if (historicalAverageWarnings(warnings)) return FAL_HISTORICAL_ESTIMATE_SOURCE;
  return lowerBoundWarnings(warnings) ? LOWER_BOUND_ESTIMATE_SOURCE : null;
}

function warnedQuote(estimate: CostEstimate): UsageQuote | null {
  const source = estimate.usd > 0 ? warnedQuoteSource(estimate.warnings) : null;
  if (!source) return null;
  return {
    estimateUsd: estimate.usd,
    estimateSource: source,
    estimateRateAsOf: estimate.rateAsOf,
  };
}

async function priceRequest(provider: Provider, model: string, payload: RecordValue, endpoint: string | undefined, hints?: CostHints, baseURL?: string): Promise<PricedRequest> {
  try {
    const request: EstimateRequest = { provider, payload, baseURL, ...(endpoint ? { endpoint } : {}), ...(hints ? { costHints: hints } : {}) };
    const estimate = provider === "fal" && endpoint
      ? await estimateFalRequest(endpoint, payload, hints)
      : cost.estimate(request);
    const quote = warnedQuote(estimate);
    if (!quote && (estimate.warnings.length || estimate.source === "tokens-heuristic+table")) {
      return { ...unknownPrice(estimate.warnings.length ? estimate.warnings : ["Waiting for reported token usage"]), quote: null };
    }
    const historical = quote?.estimateSource === FAL_HISTORICAL_ESTIMATE_SOURCE;
    return {
      ...unknownPrice(quote ? estimate.warnings : []),
      costUsd: estimate.usd,
      basis: estimate.source === "free" ? "free" : "estimated",
      rateSource: (rateFor(provider, model) ?? (endpoint ? rateFor(provider, endpoint) : undefined))?.source.url ?? null,
      pricingVersion: `apicity-${COST_PACKAGE_VERSION}:${estimate.rateAsOf ?? (historical ? "fal-historical" : PRICING_AS_OF)}`,
      units: estimate.breakdown.units ?? null,
      unit: estimate.breakdown.unit ?? null,
      quote,
    };
  } catch { return { ...unknownPrice(), quote: null }; }
}

const MEDIA_ACTIVITY: Record<Media, UsageEntry["activity"]> = { image: "images", video: "video", audio: "audio" };
const MACHGEN_IMAGE_TASKS = new Set(["T2I", "I2I"]);

function machgenActivity(payload: RecordValue): UsageEntry["activity"] {
  return MACHGEN_IMAGE_TASKS.has(String(payload.task_type)) ? "images" : "video";
}

function kieSunoApiId(provider: Provider, path: string): string | undefined {
  const match = provider === "kie" ? /\/api\/v1\/generate(\/sounds)?$/u.exec(path) : null;
  if (!match) return undefined;
  return match[1] ? "suno/sounds-generate" : "suno/generate";
}

function catalogMedia(provider: Provider, model: string, path: string): Media | undefined {
  return modelEntry(provider === "fal" ? `fal:${path.slice(1)}` : `${provider}:${kieSunoApiId(provider, path) ?? model}`)?.media;
}

function endpointModel(provider: Provider, endpoint: string): string {
  if (provider === "fal") return endpoint;
  if (provider === "wavespeed") return endpoint.replace(/^api\/v3\//u, "");
  return endpoint.split("/").slice(-2).join("/");
}

function activityFor(provider: Provider, model: string, path: string, operation = ""): UsageEntry["activity"] {
  if (/\/(responses|completions)$/u.test(path) && /chat|rewrite_prompt/u.test(operation)) return "chat";
  const media = catalogMedia(provider, model, path);
  if (media) return MEDIA_ACTIVITY[media];
  if (/transcrib|speech.to.text|analy|describe|tag_|rename|suggest|translate|vision|image.subjects|regions|verify/iu.test(`${operation} ${path}`)) return "analysis";
  if (/video|veo|wan\/|kling|seedance|happyhorse|lipsync/iu.test(`${model} ${path}`)) return "video";
  if (/audio|speech|music|sound|sfx|suno|vocal/iu.test(`${model} ${path}`)) return "audio";
  if (/image|banana|seedream|qwen|flux|ideogram/iu.test(`${model} ${path}`)) return "images";
  return "analysis";
}

function isBillable(provider: Provider, path: string, method: string): boolean {
  if (method !== "POST") return false;
  if (provider === "openai" || provider === "xai") return /\/(responses|chat\/completions|images\/(generations|edits)|videos\/(generations|edits|extensions)|audio\/(speech|transcriptions|translations)|embeddings|tts|stt)$/u.test(path);
  if (provider === "kie") return /\/(createTask|veo\/(generate|extend))$/u.test(path) || kieSunoApiId(provider, path) !== undefined;
  if (provider === "fal") return !/\/requests\//u.test(path)
    && (/^\/(fal-ai|alibaba)\//u.test(path) || modelEntry(`fal:${path.slice(1)}`) !== undefined);
  if (provider === "alibaba") return path.includes("/services/aigc/");
  if (provider === "elevenlabs") return /\/(text-to-speech|speech-to-text|speech-to-speech|sound-generation|audio-isolation|music)(\/|$)/u.test(path);
  if (provider === "machgen") return path === "/api/v0/generate";
  if (provider === "wavespeed") return path.startsWith("/api/v3/") && !path.startsWith("/api/v3/predictions/");
  return /\/(videos|images)(\/|$)/u.test(path);
}

function cloneHeldForBody<T extends Request | Response>(original: T): T {
  const copy = original.clone() as T;
  if (original.body) clonesHeldForBody.set(original.body, copy);
  return copy;
}

async function payloadOf(input: RequestInfo | URL, init?: RequestInit): Promise<RecordValue> {
  const body = init?.body;
  if (typeof body === "string") {
    try { return object(JSON.parse(body)); } catch { return {}; }
  }
  if (body instanceof FormData) return Object.fromEntries([...body.entries()].filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  if (input instanceof Request && input.headers.get("content-type")?.includes("application/json")) {
    try { return object(await cloneHeldForBody(input).json()); } catch { return {}; }
  }
  return {};
}

function remoteId(body: RecordValue, url: URL, method: string): string | null {
  const data = object(body.data);
  const output = object(body.output);
  const pathId = url.searchParams.get("taskId") ?? url.searchParams.get("task_id")
    ?? (/\/(requests|tasks|jobs|videos|predictions)\/([^/]+)(?:\/status|\/result)?$/u.exec(url.pathname)?.[2] ?? null);
  if (method === "GET" && pathId) return decodeURIComponent(pathId);
  return text(data.taskId) ?? text(data.task_id) ?? text(body.task_id) ?? text(body.request_id) ?? text(body.job_id)
    ?? text(output.task_id) ?? text(body.id) ?? text(data.id);
}

function responseStatus(body: RecordValue, accepted: boolean): UsageEntry["status"] {
  const data = object(body.data);
  const output = object(body.output);
  const state = String(body.status ?? data.state ?? data.status ?? output.task_status ?? "").toLowerCase();
  if (body.error || data.failCode || (typeof body.code === "number" && body.code >= 400) || data.successFlag === 2 || data.successFlag === 3
    || ["failed", "fail", "error", "timeout", "create_task_failed", "generate_audio_failed", "sensitive_word_error"].includes(state)) return "failed";
  if (["cancelled", "canceled", "deleted"].includes(state)) return "cancelled";
  if (state === "uncertain" || state === "expired") return "uncertain";
  if (data.successFlag === 1 || ["success", "succeeded", "completed", "done"].includes(state)) return "completed";
  if (data.successFlag === 0
    || ["created", "pending", "queued", "in_queue", "running", "in_progress", "processing", "started", "waiting", "queuing", "generating", "text_success"].includes(state)) return "pending";
  return accepted ? "pending" : "completed";
}

function actualPatch(actual: CostActual, status: UsageEntry["status"]): Partial<UsageEntry> {
  const usage = actual.usage;
  const units = usage.billableUnits ?? usage.credits ?? usage.seconds ?? usage.characters ?? usage.images;
  const unit = usage.billableUnits !== undefined ? "billable-units" : usage.credits !== undefined ? "credits"
    : usage.seconds !== undefined ? "seconds" : usage.characters !== undefined ? "characters" : "images";
  const listUsd = actual.statedListUsd;
  return {
    status,
    ...(usage.inputTokens !== undefined || usage.outputTokens !== undefined ? { tokenBased: true } : {}),
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cacheReadInputTokens !== undefined ? { cachedTokens: usage.cacheReadInputTokens } : {}),
    ...(usage.cacheWriteInputTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteInputTokens } : {}),
    ...(units !== undefined ? { units, unit } : {}),
    ...(typeof listUsd === "number" ? { listUsd } : {}),
    ...(actual.basis !== "none" ? {
      costUsd: actual.usd,
      basis: actual.basis === "stated" ? "reported" as const : actual.basis === "derived" ? "estimated" as const : "unknown" as const,
      warnings: actual.warnings,
      pricingVersion: `apicity-${COST_PACKAGE_VERSION}:${actual.rateAsOf ?? PRICING_AS_OF}`,
      actualBasis: actual.basis,
    } : { actualBasis: actual.basis }),
  };
}

const MACHGEN_BILLING_PATH = /\/api\/v0\/tasks\/([^/]+)\/billing$/u;
const FAL_QUEUE_RESULT_PATH = /\/requests\/[^/]+$/u;
export const FAL_RESULT_OMITTED_UNITS_WARNING = "Awaiting fal's billed units; the result omitted x-fal-billable-units";

function machgenBillingTaskId(provider: Provider, url: URL): string | null {
  if (provider !== "machgen") return null;
  const match = MACHGEN_BILLING_PATH.exec(url.pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function falResultFailed(provider: Provider, url: URL, response: Response): boolean {
  return provider === "fal" && !response.ok && response.status !== 429 && FAL_QUEUE_RESULT_PATH.test(url.pathname);
}

function polledStatus(existing: UsageEntry, body: RecordValue, url: URL, response: Response, billingId: string | null): UsageEntry["status"] {
  if (!response.ok) return "failed";
  if (billingId) return existing.status === "failed" || existing.status === "cancelled" ? existing.status : "completed";
  return responseStatus(body, /\/status$/u.test(url.pathname));
}

function attributionIds(): Pick<UsageInput, "notebookId" | "cellId" | "jobId" | "runId"> {
  const context = currentBookContext();
  return {
    notebookId: context?.notebookId ?? null,
    cellId: context?.cellId ?? null,
    jobId: context?.jobId ?? null,
    runId: context?.runId ?? null,
  };
}

function observedActual(engine: Engine, entry: UsageEntry | UsageInput, exchange: ProviderExchange): CostActual {
  const key = `provider-actual:${entry.id}`;
  const current = extractActual(exchange);
  try {
    const previous = engine.settings.get<CostActual>(key);
    const actual = mergeActuals(previous ? [previous, current] : [current]);
    engine.settings.set(key, actual);
    return actual;
  } catch {
    markIncomplete(engine);
    return current;
  }
}

function statedFalUnits(exchange: ProviderExchange): number | null {
  const raw = exchange.responseHeaders["x-fal-billable-units"]?.trim();
  const units = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(units) ? units : null;
}

function falNotBilledReason(exchange: ProviderExchange): string {
  if (exchange.status < 400) return "fal billed 0 units for this request";
  const detail = falErrorDetail(exchange.responseBody).slice(0, 500);
  return `fal answered HTTP ${exchange.status} and billed 0 units${detail ? `: ${detail}` : ""}`;
}

async function nothingBilledUsd(model: string): Promise<number | null> {
  if (!isFalDynamicPricingEndpoint(model)) return 0;
  const estimate = await estimateFalRequest(model, {}, undefined, 0);
  return estimate.source === "free" ? estimate.usd : null;
}

async function falNotBilledPatch(exchange: ProviderExchange, status: UsageEntry["status"], model: string): Promise<Partial<UsageEntry> | null> {
  if (exchange.provider !== "fal" || status === "pending") return null;
  const refused = exchange.status === 422 && falRefusalCategories(exchange.responseBody) !== null;
  if (!refused && statedFalUnits(exchange) !== 0) return null;
  if (/\/status$/u.test(new URL(exchange.url).pathname)) return null;
  const costUsd = refused ? 0 : await nothingBilledUsd(model);
  if (costUsd === null) return null;
  return {
    status, costUsd, basis: "free", units: 0, unit: "billable-units", actualBasis: "derived",
    warnings: [falNotBilledReason(exchange)],
  };
}

function falResultOmittedUnits(exchange: ProviderExchange, status: UsageEntry["status"], entry: UsageEntry | UsageInput, actual: CostActual): Partial<UsageEntry> | null {
  if (exchange.provider !== "fal" || status !== "completed" || actual.basis !== "none") return null;
  if (!FAL_QUEUE_RESULT_PATH.test(new URL(exchange.url).pathname) || statedFalUnits(exchange) !== null) return null;
  if (!isFalDynamicPricingEndpoint(entry.model)) return null;
  return { status, actualBasis: "none", warnings: [FAL_RESULT_OMITTED_UNITS_WARNING] };
}

async function observedPatch(engine: Engine, entry: UsageEntry | UsageInput, exchange: ProviderExchange, status: UsageEntry["status"]): Promise<Partial<UsageEntry>> {
  const actual = observedActual(engine, entry, exchange);
  const notBilled = await falNotBilledPatch(exchange, status, entry.model);
  if (notBilled) return notBilled;
  if (exchange.provider === "fal" && isFalDynamicPricingEndpoint(entry.model) && actual.usage.billableUnits !== undefined && actual.statedUsd === null) {
    const estimate = await estimateFalRequest(entry.model, {}, undefined, actual.usage.billableUnits);
    if (estimate.warnings.length === 0) {
      actual.usd = estimate.usd;
      actual.derivedUsd = estimate.usd;
      actual.basis = "derived";
      actual.rateAsOf = estimate.rateAsOf;
      actual.warnings = [];
      engine.settings.set(`provider-actual:${entry.id}`, actual);
    }
  }
  const omitted = falResultOmittedUnits(exchange, status, entry, actual);
  if (omitted) return omitted;
  return actualPatch(actual, status);
}

async function costHints(engine: Engine, artifactId?: string): Promise<CostHints | undefined> {
  if (!artifactId) return undefined;
  const result = await engine.metadata.artifacts.read<RecordValue>(artifactId, "generation-cost-hints");
  if (!result.ok) return undefined;
  const hints = result.value;
  const durationSeconds = number(hints.durationSeconds) ?? number(hints.duration);
  const inputDurationSeconds = number(hints.inputDurationSeconds) ?? number(hints.inputDuration);
  const inputWidth = number(hints.inputWidth);
  const inputHeight = number(hints.inputHeight);
  return {
    ...(durationSeconds !== null ? { durationSeconds } : {}),
    ...(inputDurationSeconds !== null ? { inputDurationSeconds } : {}),
    ...(inputWidth !== null && inputHeight !== null ? { inputWidth, inputHeight } : {}),
  };
}

export function withUsageCostHints<T>(hints: CostHints, operation: () => Promise<T>): Promise<T> {
  return usageCostHints.run(hints, operation);
}

export function withQuotedEstimate<T>(estimate: CostEstimate, operation: () => Promise<T>): Promise<T> {
  return quotedEstimates.run({
    estimateUsd: estimate.usd,
    estimateSource: estimate.source,
    estimateRateAsOf: estimate.rateAsOf,
  }, operation);
}

function positiveSeconds(value: number | null): number | undefined {
  return value !== null && value > 0 ? value : undefined;
}

function mergeCostHints(artifact: CostHints | undefined, explicit: CostHints | undefined): CostHints | undefined {
  const durationSeconds = positiveSeconds(number(explicit?.durationSeconds));
  const inputDurationSeconds = positiveSeconds(number(explicit?.inputDurationSeconds));
  if (!artifact && !explicit) return undefined;
  return {
    ...artifact, ...explicit,
    durationSeconds: durationSeconds ?? artifact?.durationSeconds,
    inputDurationSeconds: inputDurationSeconds ?? artifact?.inputDurationSeconds,
  };
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
    const payload = billable ? await payloadOf(input, init) : null;
    if (billable && payload) {
      const endpoint = url.pathname.replace(/^\//u, "");
      const model = text(payload.model) ?? text(payload.model_id) ?? endpointModel(provider, endpoint);
      let hints: CostHints | undefined;
      try { hints = await costHints(engine, context.artifactId); } catch { void 0; }
      hints = mergeCostHints(hints, usageCostHints.getStore());
      const activity = provider === "machgen" ? machgenActivity(payload) : activityFor(provider, model, url.pathname, context.operation);
      const quoteEndpoint = provider === "fal" ? endpoint : provider === "wavespeed" ? model : kieSunoApiId(provider, url.pathname);
      const quoted = quotedEstimates.getStore() ?? usageQuote({
        provider, method, dotPath: httpDotPath(url.pathname), payload,
        ...(quoteEndpoint ? { endpoint: quoteEndpoint } : {}),
        ...(hints ? { costHints: hints } : {}),
      });
      const { quote: warned, ...price } = await priceRequest(provider, model, payload, quoteEndpoint, hints, url.href);
      const quote = quoted.estimateUsd !== null ? quoted : warned ?? quoted;
      entry = {
        id: randomUUID(), provider, model, activity, status: "pending",
        tokenBased: /\/(responses|completions|embeddings)$/u.test(url.pathname),
        operation: context.operation ?? null, artifactId: context.artifactId ?? null,
        ...price,
        estimateUsd: quote.estimateUsd,
        estimateSource: quote.estimateSource,
        estimateRateAsOf: quote.estimateRateAsOf,
        ...attributionIds(),
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
      const body = json ? object(await cloneHeldForBody(response).json()) : {};
      const externalId = remoteId(body, url, method);
      const exchange: ProviderExchange = {
        provider, method, url: url.href, status: response.status,
        requestBody: payload, responseBody: body,
        responseHeaders: Object.fromEntries(response.headers.entries()),
      };
      if (entry) {
        const accepted = !!externalId && (provider === "kie" || provider === "fal" || provider === "machgen" || provider === "wavespeed" || /videos|tasks/u.test(url.pathname) || !!object(body.output).task_id);
        const status = response.ok ? responseStatus(body, accepted) : "failed";
        safeRecord(engine, { ...entry, ...(externalId ? { externalId } : {}), ...await observedPatch(engine, entry, exchange, status) });
      } else if (method === "GET" && (response.ok || falResultFailed(provider, url, response))) {
        const billingId = machgenBillingTaskId(provider, url);
        const linkedId = billingId ?? externalId;
        if (linkedId) {
          const existing = engine.usage.find(provider, linkedId);
          if (existing) {
            const status = polledStatus(existing, body, url, response, billingId);
            safeRecord(engine, { ...existing, ...await observedPatch(engine, existing, exchange, status) });
          }
        }
      }
    } catch {
      if (entry) safeRecord(engine, { ...entry, status: "uncertain", basis: "unknown", warnings: ["Provider usage unavailable"] });
    }
    return response;
  };
}

function recordEventUsage(engine: Engine, entry: UsageInput, url: string, event: unknown): void {
  const body = object(event);
  const usage = object(body.usage);
  const responseBody = { ...body, usage: {
    ...usage,
    input_tokens_details: usage.input_tokens_details ?? usage.input_token_details,
    output_tokens_details: usage.output_tokens_details ?? usage.output_token_details,
  } };
  const actual = observedActual(engine, entry, {
    provider: entry.provider, method: "POST", url, status: 200,
    requestBody: { model: entry.model }, responseBody, responseHeaders: {},
  });
  safeRecord(engine, { ...entry, ...actualPatch(actual, responseStatus(body, false)) });
}

export function recordVoiceUsage(engine: Engine, provider: "openai" | "xai", model: string, sessionId: string, responseId: string, response: unknown): void {
  const entry: UsageInput = {
    id: `voice:${sessionId}:${responseId}`, externalId: `voice:${sessionId}:${responseId}`,
    provider, model, activity: "voice", tokenBased: true,
    ...unknownPrice(),
    ...attributionIds(),
  };
  recordEventUsage(engine, entry, provider === "openai" ? "https://api.openai.com/v1/realtime" : "https://api.x.ai/v1/realtime", response);
}

export function recordTranscriptionUsage(engine: Engine, model: string, sessionId: string, itemId: string, event: unknown): void {
  const entry: UsageInput = {
    id: `transcription:${sessionId}:${itemId}`, externalId: `transcription:${sessionId}:${itemId}`,
    provider: "openai", model, activity: "analysis", tokenBased: true, ...unknownPrice(),
    ...attributionIds(),
  };
  recordEventUsage(engine, entry, "https://api.openai.com/v1/audio/transcriptions", event);
}
