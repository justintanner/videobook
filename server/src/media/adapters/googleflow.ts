import type { GoogleFlowImagesRequest, GoogleFlowVideosRequest } from "@apicity/googleflow";
import type { Engine } from "videobook-engine";
import {
  callGoogleFlowWithCaptchaRetry,
  createGoogleFlowProvider,
  submitGoogleFlowVideoTask,
  uploadAssetToGoogleFlow,
  uploadUrlToGoogleFlow,
} from "../../jobs/_google-flow.js";
import { record } from "./pending.js";
import { MEDIA_TASK_TYPES, type ProviderAdapter, type SubmitContext, type SubmitResult } from "./types.js";

function firstImageUrl(response: unknown): string | null {
  const media = record(response)?.media;
  if (!Array.isArray(media)) return null;
  for (const entry of media) {
    const url = record(record(record(entry)?.image)?.generatedImage)?.fifeUrl;
    if (typeof url === "string" && url !== "") return url;
  }
  return null;
}

async function submitImage(request: Record<string, unknown>): Promise<SubmitResult> {
  const provider = createGoogleFlowProvider();
  const response = await callGoogleFlowWithCaptchaRetry(
    (body) => provider.v1.images(body as GoogleFlowImagesRequest),
    request,
  );
  const url = firstImageUrl(response);
  if (!url) throw new Error("Google Flow image generation returned no image URL");
  return { kind: "done", taskId: url, outputs: [{ url }] };
}

async function submitVideo(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  const taskId = await submitGoogleFlowVideoTask(context.engine, context.ctx, {
    request: request as unknown as GoogleFlowVideosRequest,
    assetId: context.assetId,
    assetDir: context.assetDir,
    bookId: context.bookId,
    taskType: MEDIA_TASK_TYPES.googleflow,
    meta: context.meta,
  });
  return { kind: "pending", taskId };
}

export const googleFlowAdapter: ProviderAdapter = {
  provider: "googleflow",
  envKey: "GOOGLE_FLOW_API_KEY",
  upload: (engine: Engine, assetId: string, filename: string) =>
    uploadAssetToGoogleFlow(createGoogleFlowProvider(), engine, assetId, filename),
  uploadUrl: (url) => uploadUrlToGoogleFlow(createGoogleFlowProvider(), url),
  submit: (request, context) => context.model.media === "image" ? submitImage(request) : submitVideo(request, context),
};
