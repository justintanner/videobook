import { createFal } from "../../usage-providers.js";
import { requireApiKey } from "../../api-key.js";
import { uploadAssetToFal } from "../../jobs/_fal-upload.js";
import { describeFalError } from "../../jobs/_fal-shared.js";
import { withProviderHandoff } from "../../jobs/_lease.js";
import { providerEndpoints } from "../endpoints.js";
import { writePendingTask } from "./pending.js";
import { MEDIA_TASK_TYPES, type ProviderAdapter, type SubmitContext, type SubmitResult } from "./types.js";

function falProvider(): ReturnType<typeof createFal> {
  const queueBaseURL = providerEndpoints().falQueueBaseURL;
  return createFal({
    apiKey: requireApiKey("FAL_API_KEY"),
    timeout: 60_000,
    ...(queueBaseURL ? { queueBaseURL } : {}),
  });
}

async function submitQueued(request: Record<string, unknown>, context: SubmitContext, ownerId: string): Promise<string> {
  const endpointId = context.model.apiId;
  let submitted: { request_id: string };
  try {
    submitted = await falProvider().post.v1.queue.submit({ endpoint_id: endpointId, input: request } as never);
  } catch (cause) {
    const message = describeFalError(cause);
    if (cause instanceof Error && message === cause.message) throw cause;
    throw new Error(message, { cause });
  }
  await writePendingTask(context, submitted.request_id, MEDIA_TASK_TYPES.fal, { falEndpointId: endpointId }, ownerId);
  return submitted.request_id;
}

async function submit(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  const taskId = await withProviderHandoff(context.engine, context.assetId, context.ctx, "generate", async (ownerId) => {
    const id = await submitQueued(request, context, ownerId);
    return { taskId: id, result: id };
  });
  return { kind: "pending", taskId };
}

export const falAdapter: ProviderAdapter = {
  provider: "fal",
  envKey: "FAL_API_KEY",
  upload: uploadAssetToFal,
  uploadUrl: async (url) => url,
  submit,
};
