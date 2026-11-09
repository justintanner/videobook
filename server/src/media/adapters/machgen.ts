import { isMachGenQuotePriced, resolveMachGenUpscaleEstimate, type CostEstimate, type CostHints } from "@apicity/cost";
import type { MachGenGenerateRequest, MachGenUpscaleQuoteRequest } from "@apicity/machgen";
import type { Engine } from "videobook-engine";
import { createMachGen } from "../../usage-providers.js";
import { requireApiKey } from "../../api-key.js";
import { withQuotedEstimate } from "../../provider-usage.js";
import { prepareAssetForUpload, uploadAssetFile, type UploadLimits } from "../../upload.js";
import { providerEndpoints } from "../endpoints.js";
import { machgenTopaz } from "../machgen.js";
import type { Media } from "../types.js";
import { nonEmpty, record, writePendingTask } from "./pending.js";
import { MEDIA_TASK_TYPES, type ProviderAdapter, type ProviderOutput, type SubmitContext, type SubmitResult } from "./types.js";

const ASSET_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const QUOTE_TIMEOUT_MS = 15_000;
const QUOTE_TTL_MS = 5 * 60_000;
const QUOTE_CACHE_SIZE = 128;
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const upscaleQuotes = new Map<string, { quotedAt: number; estimate: CostEstimate }>();

export function machgenProvider(timeout = 60_000, baseURL = providerEndpoints().machgenBaseURL): ReturnType<typeof createMachGen> {
  return createMachGen({
    apiKey: requireApiKey("MACHGEN_API_KEY"),
    timeout,
    ...(baseURL ? { baseURL } : {}),
  });
}

function rememberQuote(key: string, estimate: CostEstimate): void {
  upscaleQuotes.delete(key);
  upscaleQuotes.set(key, { quotedAt: Date.now(), estimate });
  const oldest = upscaleQuotes.keys().next();
  if (upscaleQuotes.size > QUOTE_CACHE_SIZE && !oldest.done) upscaleQuotes.delete(oldest.value);
}

export function resetMachGenUpscaleQuotesForTests(): void {
  upscaleQuotes.clear();
}

export async function quoteMachGenUpscale(request: Record<string, unknown>, hints: CostHints, signal?: AbortSignal): Promise<CostEstimate> {
  const key = JSON.stringify(request);
  const cached = upscaleQuotes.get(key);
  if (cached && Date.now() - cached.quotedAt < QUOTE_TTL_MS) return cached.estimate;
  const estimate = await resolveMachGenUpscaleEstimate(
    request,
    (payload) => machgenProvider(QUOTE_TIMEOUT_MS).api.v0.upscale.quote(payload as unknown as MachGenUpscaleQuoteRequest, signal),
    { hints },
  );
  if (estimate.warnings.length === 0) rememberQuote(key, estimate);
  return estimate;
}

function costHints(request: Record<string, unknown>, hints: CostHints): CostHints {
  const seconds = record(request.video_config)?.duration_secs;
  return {
    ...(typeof seconds === "number" && seconds > 0 ? { durationSeconds: seconds } : {}),
    ...hints,
  };
}

async function submit(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  const hints = costHints(request, context.costHints);
  if (Object.keys(hints).length > 0) {
    const written = await context.engine.metadata.artifacts.write(context.assetId, "generation-cost-hints", hints);
    if (!written.ok) throw new Error(written.error.message);
  }
  const generate = () => machgenProvider().api.v0.generate(request as unknown as MachGenGenerateRequest, context.ctx.signal);
  const quote = isMachGenQuotePriced(request) ? await quoteMachGenUpscale(request, hints, context.ctx.signal) : null;
  const response = quote && quote.warnings.length === 0 ? await withQuotedEstimate(quote, generate) : await generate();
  const taskId = nonEmpty(response.task_id);
  if (!taskId) throw new Error("MachGen accepted the request without a task id");
  const machgenModel = typeof request.model === "string" ? request.model : context.model.apiId;
  await writePendingTask(context, taskId, MEDIA_TASK_TYPES.machgen, { machgenModel });
  return { kind: "pending", taskId };
}

function imageExtension(bytes: Buffer): string {
  if (bytes.subarray(0, 3).equals(JPEG_SIGNATURE)) return "jpg";
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "webp";
  return "png";
}

export async function downloadMachGenOutput(taskId: string, media: Media, url?: string): Promise<ProviderOutput> {
  const bytes = Buffer.from(await machgenProvider(ASSET_DOWNLOAD_TIMEOUT_MS).api.v0.assets(taskId));
  if (bytes.length === 0) throw new Error(`MachGen task ${taskId} returned an empty ${media}`);
  return { bytes, extension: media === "image" ? imageExtension(bytes) : "mp4", ...(url ? { url } : {}) };
}

async function uploadAssetToMachGen(engine: Engine, assetId: string, filename: string, signal?: AbortSignal, limits?: UploadLimits): Promise<string> {
  signal?.throwIfAborted();
  const { data, hashedFilename, contentType } = await prepareAssetForUpload(engine, assetId, filename, signal, limits);
  const file = new Blob([new Uint8Array(data)], { type: contentType });
  const uploaded = await machgenProvider(UPLOAD_TIMEOUT_MS).api.v0.upload({ file, filename: hashedFilename }, signal);
  const artifactPath = nonEmpty(uploaded.artifact_path);
  if (!artifactPath) throw new Error("MachGen accepted the upload without an artifact path");
  return `@input/${artifactPath}`;
}

const machgenAdapter: ProviderAdapter = {
  provider: "machgen",
  envKey: "MACHGEN_API_KEY",
  upload: uploadAssetFile,
  uploadUrl: async (url) => url,
  submit,
};

const machgenTopazAdapter: ProviderAdapter = { ...machgenAdapter, upload: uploadAssetToMachGen };

export function machgenAdapterFor(apiId: string): ProviderAdapter {
  return machgenTopaz(apiId) ? machgenTopazAdapter : machgenAdapter;
}
