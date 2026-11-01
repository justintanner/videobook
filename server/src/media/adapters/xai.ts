import type { XaiImageEditRequest, XaiImageGenerateRequest, XaiImageResponse, XaiVideoAsyncResponse, XaiVideoGenerateRequest } from "@apicity/xai";
import { requireApiKey } from "../../api-key.js";
import { uploadAssetFile } from "../../upload.js";
import {
  callXaiPaid,
  createXaiPaygatedProvider,
  XAI_IMAGE_GENERATIONS_DOT_PATH,
  XAI_VIDEO_GENERATIONS_DOT_PATH,
} from "../../jobs/xai-paygate.js";
import { providerEndpoints } from "../endpoints.js";
import { hasXaiImageSources, isXaiImageModel } from "../wire.js";
import { writePendingTask } from "./pending.js";
import { MEDIA_TASK_TYPES, type ProviderAdapter, type ProviderOutput, type SubmitContext, type SubmitResult } from "./types.js";

function xaiProvider(): ReturnType<typeof createXaiPaygatedProvider> {
  return createXaiPaygatedProvider(requireApiKey("XAI_API_KEY"), 120_000, providerEndpoints().xaiBaseURL);
}

function imageOutputs(response: XaiImageResponse): ProviderOutput[] {
  return response.data.flatMap((image): ProviderOutput[] => {
    if (image.url) return [{ url: image.url }];
    if (image.b64_json) return [{ bytes: Buffer.from(image.b64_json, "base64"), extension: image.mime_type === "image/png" ? "png" : "jpg" }];
    return [];
  });
}

async function requestImage(request: Record<string, unknown>): Promise<XaiImageResponse> {
  const provider = xaiProvider();
  if (hasXaiImageSources(request)) {
    return callXaiPaid<XaiImageEditRequest, XaiImageResponse>(provider.post.v1.images.edits, "v1.images.edits", request as unknown as XaiImageEditRequest);
  }
  return callXaiPaid<XaiImageGenerateRequest, XaiImageResponse>(
    provider.post.v1.images.generations,
    XAI_IMAGE_GENERATIONS_DOT_PATH,
    request as unknown as XaiImageGenerateRequest,
  );
}

async function submitImage(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  const outputs = imageOutputs(await requestImage(request));
  if (outputs.length === 0) throw new Error("xAI response contained no images");
  return { kind: "done", taskId: `${context.model.apiId}-${Date.now()}`, outputs };
}

async function submitVideo(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  const { request_id } = await callXaiPaid<XaiVideoGenerateRequest, XaiVideoAsyncResponse>(
    xaiProvider().post.v1.videos.generations,
    XAI_VIDEO_GENERATIONS_DOT_PATH,
    request as unknown as XaiVideoGenerateRequest,
  );
  await writePendingTask(context, request_id, MEDIA_TASK_TYPES.xai);
  return { kind: "pending", taskId: request_id };
}

async function submit(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  return isXaiImageModel(context.model.apiId) ? submitImage(request, context) : submitVideo(request, context);
}

export const xaiAdapter: ProviderAdapter = {
  provider: "xai",
  envKey: "XAI_API_KEY",
  upload: uploadAssetFile,
  uploadUrl: async (url) => url,
  submit,
};
