import type { XaiVideoAsyncResponse, XaiVideoGenerateRequest } from "@apicity/xai";
import { requireApiKey } from "../../api-key.js";
import { uploadAssetFile } from "../../upload.js";
import { callXaiPaid, createXaiPaygatedProvider, XAI_VIDEO_GENERATIONS_DOT_PATH } from "../../jobs/xai-paygate.js";
import { writePendingTask } from "./pending.js";
import { MEDIA_TASK_TYPES, type ProviderAdapter, type SubmitContext, type SubmitResult } from "./types.js";

async function submit(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  const provider = createXaiPaygatedProvider(requireApiKey("XAI_API_KEY"), 120_000);
  const { request_id } = await callXaiPaid<XaiVideoGenerateRequest, XaiVideoAsyncResponse>(
    provider.post.v1.videos.generations,
    XAI_VIDEO_GENERATIONS_DOT_PATH,
    request as unknown as XaiVideoGenerateRequest,
  );
  await writePendingTask(context, request_id, MEDIA_TASK_TYPES.xai);
  return { kind: "pending", taskId: request_id };
}

export const xaiAdapter: ProviderAdapter = {
  provider: "xai",
  envKey: "XAI_API_KEY",
  upload: uploadAssetFile,
  uploadUrl: async (url) => url,
  submit,
};
