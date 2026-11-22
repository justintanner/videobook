import type { AlibabaMultimodalGenerationRequest, AlibabaVideoSynthesisRequest } from "@apicity/alibaba/zod";
import { createAlibaba } from "../../usage-providers.js";
import { requireApiKey } from "../../api-key.js";
import { uploadAssetToAlibaba } from "../../jobs/_alibaba-upload.js";
import { isAlibabaVideoModel } from "../alibaba.js";
import { providerEndpoints } from "../endpoints.js";
import { nonEmpty, writePendingTask } from "./pending.js";
import { MEDIA_TASK_TYPES, type ProviderAdapter, type SubmitContext, type SubmitResult } from "./types.js";

export const ALIBABA_INTERNATIONAL_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

export function alibabaProvider(timeout = 120_000, baseURL = providerEndpoints().alibabaBaseURL): ReturnType<typeof createAlibaba> {
  return createAlibaba({
    apiKey: requireApiKey("DASHSCOPE_API_KEY"),
    timeout,
    ...(baseURL ? { baseURL } : {}),
  });
}

async function writeCostHints(context: SubmitContext): Promise<void> {
  if (Object.keys(context.costHints).length === 0) return;
  const written = await context.engine.metadata.artifacts.write(context.assetId, "generation-cost-hints", context.costHints);
  if (!written.ok) throw new Error(written.error.message);
}

async function submitImage(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  const provider = alibabaProvider(120_000);
  const response = await provider.post.api.v1.services.aigc.multimodalGeneration.generation(
    request as unknown as AlibabaMultimodalGenerationRequest,
    context.ctx.signal,
  );
  const urls = response.output.choices.flatMap((choice) =>
    choice.message.content.flatMap((part) => part.image ? [part.image] : []));
  if (urls.length === 0) throw new Error("Alibaba response contained no image URLs");
  return { kind: "done", taskId: response.request_id, outputs: urls.map((url) => ({ url })) };
}

async function submitVideo(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  const hints = { alibabaDeploymentScope: "International" as const, ...context.costHints };
  await writeCostHints({ ...context, costHints: hints });
  const baseURL = providerEndpoints().alibabaBaseURL ?? ALIBABA_INTERNATIONAL_BASE_URL;
  const provider = alibabaProvider(60_000, baseURL);
  const response = await provider.post.api.v1.services.aigc.videoGeneration.videoSynthesis(
    request as unknown as AlibabaVideoSynthesisRequest,
    context.ctx.signal,
  );
  const taskId = nonEmpty(response.output?.task_id);
  if (!taskId) throw new Error("Alibaba accepted the video request without a task id");
  await writePendingTask(context, taskId, MEDIA_TASK_TYPES.alibaba, { alibabaBaseURL: baseURL });
  return { kind: "pending", taskId };
}

export function alibabaAdapterFor(apiId: string): ProviderAdapter {
  const video = isAlibabaVideoModel(apiId);
  return {
    provider: "alibaba",
    envKey: "DASHSCOPE_API_KEY",
    upload: (engine, assetId, filename, signal, limits) => uploadAssetToAlibaba(engine, assetId, filename, apiId, signal, limits),
    uploadUrl: async (url) => url,
    submit: video ? submitVideo : submitImage,
  };
}
