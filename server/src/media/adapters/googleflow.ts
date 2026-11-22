import { extname } from "node:path";
import type { GoogleFlowImagesRequest, GoogleFlowResponse, GoogleFlowVideosRequest } from "@apicity/googleflow";
import type { Engine } from "videobook-engine";
import { createGoogleFlow } from "../../usage-providers.js";
import { requireApiKey } from "../../api-key.js";
import { prepareAssetForUpload, type UploadLimits } from "../../upload.js";
import { providerEndpoints } from "../endpoints.js";
import { isGoogleFlowVideoModel } from "../googleflow.js";
import { nonEmpty, record, writePendingTask } from "./pending.js";
import { MEDIA_TASK_TYPES, type ProviderAdapter, type SubmitContext, type SubmitResult } from "./types.js";

const IMAGE_TIMEOUT_MS = 5 * 60_000;
const VIDEO_SUBMIT_TIMEOUT_MS = 2 * 60_000;
const ASSET_UPLOAD_TIMEOUT_MS = 2 * 60_000;

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
};

export function googleFlowProvider(timeout = VIDEO_SUBMIT_TIMEOUT_MS, baseURL = providerEndpoints().googleFlowBaseURL): ReturnType<typeof createGoogleFlow> {
  return createGoogleFlow({
    apiKey: requireApiKey("GOOGLE_FLOW_API_KEY"),
    timeout,
    ...(baseURL ? { baseURL } : {}),
  });
}

async function writeCostHints(context: SubmitContext): Promise<void> {
  if (Object.keys(context.costHints).length === 0) return;
  const written = await context.engine.metadata.artifacts.write(context.assetId, "generation-cost-hints", context.costHints);
  if (!written.ok) throw new Error(written.error.message);
}

function extractGoogleFlowImageUrls(response: GoogleFlowResponse): string[] {
  const media = Array.isArray(response.media) ? response.media : [];
  return media.flatMap((entry) => {
    const item = record(entry);
    const image = record(item?.image);
    const generated = record(image?.generatedImage);
    const url = nonEmpty(generated?.fifeUrl) ?? nonEmpty(item?.fifeUrl) ?? nonEmpty(item?.url);
    return url ? [url] : [];
  });
}

export function extractGoogleFlowVideoUrls(response: GoogleFlowResponse): string[] {
  const media = Array.isArray(response.media) ? response.media : [];
  return media.flatMap((entry) => {
    const item = record(entry);
    const url = nonEmpty(item?.videoUrl) ?? nonEmpty(item?.url);
    return url ? [url] : [];
  });
}

export interface GoogleFlowImageResult {
  taskId: string;
  urls: string[];
}

export async function runGoogleFlowImage(
  apiId: string,
  request: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<GoogleFlowImageResult> {
  const provider = googleFlowProvider(IMAGE_TIMEOUT_MS);
  const response = await provider.post.v1.images(request as unknown as GoogleFlowImagesRequest, signal);
  const urls = extractGoogleFlowImageUrls(response);
  if (urls.length === 0) throw new Error(`Google Flow ${apiId} returned no image URLs`);
  const taskId = nonEmpty(response.jobId) ?? nonEmpty(response.jobid) ?? `${apiId}-${Date.now()}`;
  return { taskId, urls };
}

async function uploadGoogleFlowAsset(
  engine: Engine,
  assetId: string,
  filename: string,
  signal?: AbortSignal,
  limits?: UploadLimits,
): Promise<string> {
  const prepared = await prepareAssetForUpload(engine, assetId, filename, signal, limits);
  const contentType = MIME_TYPES[extname(prepared.hashedFilename).toLowerCase()];
  if (!contentType) throw new Error(`Google Flow does not accept ${filename}`);
  const provider = googleFlowProvider(ASSET_UPLOAD_TIMEOUT_MS);
  const response = await provider.post.v1.assets({
    body: new Uint8Array(prepared.data),
    contentType,
  }, signal);
  const id = nonEmpty(response.mediaGenerationId);
  if (!id) throw new Error(`Google Flow asset upload for ${filename} returned no mediaGenerationId`);
  return id;
}

async function submitVideo(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  await writeCostHints(context);
  const provider = googleFlowProvider(VIDEO_SUBMIT_TIMEOUT_MS);
  const response = await provider.post.v1.videos(request as unknown as GoogleFlowVideosRequest, context.ctx.signal);
  const urls = extractGoogleFlowVideoUrls(response);
  if (urls.length > 0) {
    const taskId = nonEmpty(response.jobId) ?? nonEmpty(response.jobid) ?? `${context.model.apiId}-${Date.now()}`;
    return { kind: "done", taskId, outputs: urls.map((url) => ({ url })) };
  }
  const jobId = nonEmpty(response.jobid) ?? nonEmpty(response.jobId);
  if (!jobId) throw new Error("Google Flow accepted the video request without a job id");
  await writePendingTask(context, jobId, MEDIA_TASK_TYPES.googleflow);
  return { kind: "pending", taskId: jobId };
}

async function submitImage(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  const result = await runGoogleFlowImage(context.model.apiId, request, context.ctx.signal);
  return { kind: "done", taskId: result.taskId, outputs: result.urls.map((url) => ({ url })) };
}

export function googleFlowAdapterFor(apiId: string): ProviderAdapter {
  const video = isGoogleFlowVideoModel(apiId);
  return {
    provider: "googleflow",
    envKey: "GOOGLE_FLOW_API_KEY",
    upload: uploadGoogleFlowAsset,
    uploadUrl: async (url) => {
      throw new Error(`Google Flow takes media from this book, not a URL: ${url}`);
    },
    submit: video ? submitVideo : submitImage,
  };
}
