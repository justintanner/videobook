import { extname } from "node:path";
import { NunchuxGoogleInteractionsRequestSchema, type NunchuxGoogleInteractionsResponse } from "@apicity/nunchux";
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
      throw new Error("Nunchux image generation does not run as a task");
  }
}

async function submit(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  await writeCostHints(context);
  if (nunchuxFamily(context.model.apiId) === "google") return generateImage(request, context);
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

export function nunchuxAdapterFor(apiId: string): ProviderAdapter {
  return nunchuxFamily(apiId) === "google" ? inlineImageAdapter : taskAdapter;
}
