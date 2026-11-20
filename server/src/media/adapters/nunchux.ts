import { extname } from "node:path";
import {
  NunchuxGoogleInteractionsRequestSchema,
  NunchuxOpenAiImagesEditsRequestSchema,
  NunchuxOpenAiImagesGenerationsRequestSchema,
  type NunchuxGoogleInteractionsResponse,
} from "@apicity/nunchux";
import type { Engine } from "videobook-engine";
import { createNunchux } from "../../usage-providers.js";
import { requireApiKey } from "../../api-key.js";
import { uploadAssetFile } from "../../upload.js";
import { providerEndpoints } from "../endpoints.js";
import { nunchuxFamily, type NunchuxPendingImagePart } from "../nunchux.js";
import { assetRef, readAssetRef } from "./asset-ref.js";
import { nonEmpty, writePendingTask } from "./pending.js";
import { MEDIA_TASK_TYPES, type ProviderAdapter, type ProviderOutput, type SubmitContext, type SubmitResult } from "./types.js";

const IMAGE_TIMEOUT_MS = 5 * 60_000;

const MIME_TYPES: Readonly<Record<string, string>> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const EXTENSIONS: Readonly<Record<string, string>> = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" };

export function nunchuxProvider(timeout = 60_000, baseURL = providerEndpoints().nunchuxBaseURL): ReturnType<typeof createNunchux> {
  return createNunchux({
    apiKey: requireApiKey("NUNCHUX_API_KEY"),
    timeout,
    ...(baseURL ? { baseURL } : {}),
  });
}

async function writeCostHints(context: SubmitContext): Promise<void> {
  if (Object.keys(context.costHints).length === 0) return;
  const written = await context.engine.metadata.artifacts.write(context.assetId, "generation-cost-hints", context.costHints);
  if (!written.ok) throw new Error(written.error.message);
}

async function inlineImage(engine: Engine, part: NunchuxPendingImagePart): Promise<{ type: "image"; data: string; mime_type: string }> {
  const { bytes, filename } = await readAssetRef(engine, part.ref);
  const mimeType = MIME_TYPES[extname(filename).toLowerCase()];
  if (!mimeType) throw new Error(`Nunchux takes JPEG, PNG or WebP images, not ${filename}`);
  return { type: "image", data: bytes.toString("base64"), mime_type: mimeType };
}

function imageOutputs(response: NunchuxGoogleInteractionsResponse): ProviderOutput[] {
  return response.steps.flatMap((step) => step.content ?? []).flatMap((part) => {
    const extension = part.mime_type ? EXTENSIONS[part.mime_type] : undefined;
    return part.type === "image" && part.data && extension ? [{ bytes: Buffer.from(part.data, "base64"), extension }] : [];
  });
}

function modelText(response: NunchuxGoogleInteractionsResponse): string {
  return response.steps.flatMap((step) => step.content ?? []).flatMap((part) => part.type === "text" && part.text ? [part.text.trim()] : []).join(" ");
}

async function generateImage(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  const parts = Array.isArray(request.input) ? request.input as Array<Record<string, unknown>> : [];
  const input = await Promise.all(parts.map((part) => part.type === "image" ? inlineImage(context.engine, part as NunchuxPendingImagePart) : part));
  const body = NunchuxGoogleInteractionsRequestSchema.parse({ ...request, input });
  const response = await nunchuxProvider(IMAGE_TIMEOUT_MS).v1.google.v1beta.interactions(body, context.ctx.signal);
  const outputs = imageOutputs(response);
  if (outputs.length === 0) {
    const reason = modelText(response);
    throw new Error(`Nunchux ${response.model} returned no image (status ${response.status})${reason ? `: ${reason}` : ""}`);
  }
  return { kind: "done", taskId: response.id, outputs };
}

async function inlineImageUrl(engine: Engine, ref: string): Promise<string> {
  if (!ref.startsWith("asset://")) return ref;
  const { bytes, filename } = await readAssetRef(engine, ref);
  const mimeType = MIME_TYPES[extname(filename).toLowerCase()];
  if (!mimeType) throw new Error(`Nunchux takes JPEG, PNG or WebP images, not ${filename}`);
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

async function inlineImagePart(engine: Engine, part: unknown): Promise<unknown> {
  const ref = (part as { image_url?: unknown } | undefined)?.image_url;
  return typeof ref === "string" ? { image_url: await inlineImageUrl(engine, ref) } : part;
}

async function inlineGptImageRequest(engine: Engine, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const inlined: Record<string, unknown> = { ...request };
  if (Array.isArray(request.images)) inlined.images = await Promise.all(request.images.map((part) => inlineImagePart(engine, part)));
  for (const field of ["mask", "markup"]) {
    if (request[field] !== undefined) inlined[field] = await inlineImagePart(engine, request[field]);
  }
  return inlined;
}

async function generateGptImage(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  const images = nunchuxProvider(IMAGE_TIMEOUT_MS).v2.openai.images;
  const body = await inlineGptImageRequest(context.engine, request);
  const response = Array.isArray(body.images)
    ? await images.edits(NunchuxOpenAiImagesEditsRequestSchema.parse(body), context.ctx.signal)
    : await images.generations(NunchuxOpenAiImagesGenerationsRequestSchema.parse(body), context.ctx.signal);
  const extension = typeof response.output_format === "string" ? response.output_format : String(request.output_format ?? "png");
  const outputs = response.data.flatMap((image) => image.b64_json ? [{ bytes: Buffer.from(image.b64_json, "base64"), extension }] : []);
  if (outputs.length === 0) throw new Error(`Nunchux ${context.model.apiId} returned no image`);
  const generationId = response.data.find((image) => image.generation_id)?.generation_id;
  return { kind: "done", taskId: generationId ?? `${context.model.apiId}-${response.created}`, outputs };
}

async function submitTask(request: Record<string, unknown>, context: SubmitContext): Promise<string | null> {
  const client = nunchuxProvider();
  const signal = context.ctx.signal;
  switch (nunchuxFamily(context.model.apiId)) {
    case "alibaba":
      return nonEmpty((await client.v1.alibaba.services.aigc.videoGeneration.videoSynthesis(request as never, signal)).output?.task_id);
    case "bytedance":
      return nonEmpty((await client.v1.bytedance.contents.generations.tasks(request as never, signal)).id);
    case "minimax":
      return nonEmpty((await client.v1.minimax.v2.videoGeneration(request as never, signal)).task_id);
    case "google":
    case "openai":
      throw new Error("Nunchux image generation does not run as a task");
  }
}

async function submit(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  await writeCostHints(context);
  const family = nunchuxFamily(context.model.apiId);
  if (family === "google") return generateImage(request, context);
  if (family === "openai") return generateGptImage(request, context);
  const taskId = await submitTask(request, context);
  if (!taskId) throw new Error("Nunchux accepted the request without a task id");
  await writePendingTask(context, taskId, MEDIA_TASK_TYPES.nunchux, { nunchuxModel: context.model.apiId });
  return { kind: "pending", taskId };
}

const inlineImageAdapter: ProviderAdapter = {
  provider: "nunchux",
  envKey: "NUNCHUX_API_KEY",
  upload: async (_engine, assetId, filename) => assetRef(assetId, filename),
  uploadUrl: async (url) => {
    throw new Error(`Nunchux Nano Banana takes images from this book, not a URL: ${url}`);
  },
  submit,
};

const taskAdapter: ProviderAdapter = {
  provider: "nunchux",
  envKey: "NUNCHUX_API_KEY",
  upload: uploadAssetFile,
  uploadUrl: async (url) => url,
  submit,
};

const gptImageAdapter: ProviderAdapter = {
  ...inlineImageAdapter,
  uploadUrl: async (url) => url,
};

export function nunchuxAdapterFor(apiId: string): ProviderAdapter {
  const family = nunchuxFamily(apiId);
  if (family === "google") return inlineImageAdapter;
  return family === "openai" ? gptImageAdapter : taskAdapter;
}
