import { setTimeout as delay } from "node:timers/promises";
import type { MediaGenerationRequest, SunoGenerateRequest, SunoSoundsRequest, VeoGenerateRequest } from "@apicity/kie";
import { submitMediaJob } from "../../usage-providers.js";
import { KieError } from "@apicity/kie";
import { createKie } from "../../usage-providers.js";
import { requireApiKey } from "../../api-key.js";
import { authorizeKiePaygate, ensurePaygateSecret, mintKieOtp } from "../../jobs/kie-paygate.js";
import { uploadAssetToKie } from "../../jobs/_kie-upload.js";
import { providerEndpoints } from "../endpoints.js";
import { isKieSunoModel, isKieVeoModel } from "../wire.js";
import { nonEmpty, writePendingTask } from "./pending.js";
import { MEDIA_TASK_TYPES, type ProviderAdapter, type SubmitContext, type SubmitResult } from "./types.js";

const VEO_DOT_PATH = "api.v1.veo.generate";
const SUNO_DOT_PATH = "api.v1.generate";
const SUNO_FAILURES = new Set(["CREATE_TASK_FAILED", "GENERATE_AUDIO_FAILED", "SENSITIVE_WORD_ERROR"]);
const SUNO_DONE = new Set(["SUCCESS", "FIRST_SUCCESS", "CALLBACK_EXCEPTION"]);

type KieProvider = ReturnType<typeof createKie>;

function kieProvider(): KieProvider {
  const baseURL = providerEndpoints().kieBaseURL;
  return createKie({
    apiKey: requireApiKey("KIE_API_KEY"),
    timeout: 60_000,
    paygate: { secret: ensurePaygateSecret() },
    ...(baseURL ? { baseURL } : {}),
  });
}

function correlation(context: SubmitContext, stage: string): Record<string, string> {
  return { bookId: context.bookId, artifactId: context.assetId, tool: context.model.id, stage };
}

async function recordTaskId(context: SubmitContext, taskId: string): Promise<void> {
  await context.engine.metadata.artifacts.write(context.assetId, "kie-task-id", { taskId });
}

async function submitCreateTask(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  const typed = request as unknown as MediaGenerationRequest;
  if (Object.keys(context.costHints).length > 0) {
    await context.engine.metadata.artifacts.write(context.assetId, "generation-cost-hints", context.costHints);
  }
  const { otp } = await authorizeKiePaygate(typed, {
    costHints: {
      ...(context.costHints.durationSeconds !== undefined ? { duration: context.costHints.durationSeconds } : {}),
      ...(context.costHints.inputDurationSeconds !== undefined ? { inputDuration: context.costHints.inputDurationSeconds } : {}),
    },
    engine: context.engine,
    correlation: correlation(context, "submit-kie"),
  });
  const taskId = await submitMediaJob(kieProvider(), typed, { otp });
  await writePendingTask(context, taskId, MEDIA_TASK_TYPES.kie);
  await recordTaskId(context, taskId);
  return { kind: "pending", taskId };
}

async function submitVeo(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  const typed = request as unknown as VeoGenerateRequest;
  const { otp } = await authorizeKiePaygate(typed as unknown as MediaGenerationRequest, {
    dotPath: VEO_DOT_PATH,
    engine: context.engine,
    correlation: correlation(context, "submit-veo"),
  });
  const result = await kieProvider().veo.post.api.v1.veo.generate(typed, { otp });
  const taskId = nonEmpty(result.data?.taskId);
  if (!taskId) throw new KieError(`veo.generate failed: ${result.code}`, result.code);
  await writePendingTask(context, taskId, MEDIA_TASK_TYPES.kie, { veoModel: context.model.apiId });
  await recordTaskId(context, taskId);
  return { kind: "pending", taskId };
}

function sunoTrackUrl(tracks: Array<{ audioUrl?: string }> | undefined): string | null {
  for (const track of tracks ?? []) {
    const url = nonEmpty(track.audioUrl);
    if (url) return url;
  }
  return null;
}

async function submitSunoTask(provider: KieProvider, request: Record<string, unknown>, apiId: string): Promise<string> {
  if (apiId === "suno/sounds-generate") {
    const response = await provider.suno.post.api.v1.generate.sounds(request as unknown as SunoSoundsRequest);
    const taskId = nonEmpty(response.data?.taskId);
    if (!taskId) throw new Error(`Suno sounds submission failed: ${response.msg ?? response.code}`);
    return taskId;
  }
  const otp = mintKieOtp(request as unknown as MediaGenerationRequest, undefined, SUNO_DOT_PATH);
  const response = await provider.suno.post.api.v1.generate(request as unknown as SunoGenerateRequest, { otp });
  const taskId = nonEmpty(response.data?.taskId);
  if (!taskId) throw new Error(`Suno submission failed: ${response.msg ?? response.code}`);
  return taskId;
}

async function pollSuno(provider: KieProvider, taskId: string, signal: AbortSignal): Promise<string> {
  const settings = providerEndpoints();
  const deadline = Date.now() + (settings.timeoutMs ?? 25 * 60_000);
  while (Date.now() < deadline) {
    const result = await provider.suno.get.api.v1.generate.recordInfo(taskId);
    const status = result.data?.status;
    const url = sunoTrackUrl(result.data?.response?.sunoData);
    if (url && status && SUNO_DONE.has(status)) return url;
    if (status && SUNO_FAILURES.has(status)) throw new Error(`Suno generation failed: ${result.data?.errorMessage || status}`);
    await delay(settings.pollIntervalMs ?? 3_000, undefined, { signal });
  }
  throw new Error(`Suno task ${taskId} did not finish in time`);
}

async function submitSuno(request: Record<string, unknown>, context: SubmitContext): Promise<SubmitResult> {
  const provider = kieProvider();
  const taskId = await submitSunoTask(provider, request, context.model.apiId);
  await recordTaskId(context, taskId);
  const url = await pollSuno(provider, taskId, context.ctx.signal);
  return { kind: "done", taskId, outputs: [{ url }] };
}

export const kieAdapter: ProviderAdapter = {
  provider: "kie",
  envKey: "KIE_API_KEY",
  upload: uploadAssetToKie,
  uploadUrl: async (url) => url,
  submit: (request, context) => {
    if (isKieVeoModel(context.model.apiId)) return submitVeo(request, context);
    if (isKieSunoModel(context.model.apiId)) return submitSuno(request, context);
    return submitCreateTask(request, context);
  },
};
