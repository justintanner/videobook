import { createWaveSpeed } from "../../usage-providers.js";
import { requireApiKey } from "../../api-key.js";
import { uploadAssetFile } from "../../upload.js";
import { providerEndpoints } from "../endpoints.js";
import { wavespeedMethod } from "../wavespeed.js";
import { nonEmpty, writePendingTask } from "./pending.js";
import { MEDIA_TASK_TYPES, type ProviderAdapter, type SubmitContext, type SubmitResult } from "./types.js";

export function wavespeedProvider(timeout = 60_000, baseURL = providerEndpoints().wavespeedBaseURL): ReturnType<typeof createWaveSpeed> {
  return createWaveSpeed({
    apiKey: requireApiKey("WAVESPEED_API_KEY"),
    timeout,
    ...(baseURL ? { baseURL } : {}),
  });
}

async function submit(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  if (Object.keys(context.costHints).length > 0) {
    const written = await context.engine.metadata.artifacts.write(context.assetId, "generation-cost-hints", context.costHints);
    if (!written.ok) throw new Error(written.error.message);
  }
  const submitModel = wavespeedMethod(wavespeedProvider(), context.model.apiId);
  const response = await submitModel(request, context.ctx.signal);
  const taskId = nonEmpty(response.data?.id);
  if (!taskId) throw new Error("WaveSpeed accepted the request without a prediction id");
  await writePendingTask(context, taskId, MEDIA_TASK_TYPES.wavespeed, { wavespeedModel: context.model.apiId });
  return { kind: "pending", taskId };
}

export const wavespeedAdapter: ProviderAdapter = {
  provider: "wavespeed",
  envKey: "WAVESPEED_API_KEY",
  upload: uploadAssetFile,
  uploadUrl: async (url) => url,
  submit,
};
