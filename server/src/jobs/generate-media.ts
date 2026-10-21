import { isSeedanceEdit } from "../media/seedance-edit.js";
import type { Engine } from "videobook-engine";
import type { CostHints } from "@apicity/cost";
import { registerJobHandler, type JobHandlerContext } from "../queue.js";
import { assertProviderPayload } from "../provider-prompt-transform.js";
import { requireApiKey } from "../api-key.js";
import { referenceVideoDuration } from "../reference-video-duration.js";
import { resolveModel } from "../media/descriptor.js";
import { buildWireRequest } from "../media/request.js";
import { applyPromptDialect } from "../media/prompt-dialects.js";
import { checkSeedanceEditSource, checkInsertVideoTiming, checkRefDurations, resolveRefInput, uploadRefs, type ResolvedRefs } from "../media/refs.js";
import { adapterFor } from "../media/adapters/index.js";
import { completeMediaGeneration } from "../media/complete.js";
import type { MediaRefs, ResolvedModel } from "../media/types.js";

export type GenerateMediaJob = {
  type: "generate_media";
  model: string;
  bookId: string;
  assetId: string;
  assetDir: string;
  prompt?: string;
  refs: MediaRefs;
  options: Record<string, unknown>;
  mode?: string;
  replaceAudioWith?: string;
};

function storedPayload(model: ResolvedModel, request: Record<string, unknown>): Record<string, unknown> {
  return model.provider === "fal" ? { endpoint_id: model.apiId, input: request } : request;
}

async function replaceAudioMeta(engine: Engine, ref: string | undefined): Promise<Record<string, unknown>> {
  if (!ref) return {};
  const input = await resolveRefInput(engine, "audio", ref);
  return { replaceAudioWith: { assetId: input.assetId, filename: input.filename } };
}

async function costHints(engine: Engine, refs: ResolvedRefs, job: GenerateMediaJob): Promise<CostHints> {
  if (refs.sourceVideoIds.length === 0) return {};
  const seconds = await referenceVideoDuration(engine, refs.sourceVideoIds);
  return seconds === undefined ? {} : { inputDurationSeconds: seconds, ...(isSeedanceEdit(job.model, job.mode) ? { durationSeconds: seconds } : {}) };
}

function generationMeta(job: GenerateMediaJob, model: ResolvedModel, refs: ResolvedRefs): Record<string, unknown> {
  return {
    model: model.id,
    media: model.media,
    prompt: job.prompt ?? "",
    sourceImageIds: refs.sourceImageIds,
    sourceVideoIds: refs.sourceVideoIds,
    sourceAudioIds: refs.sourceAudioIds,
  };
}

export async function runGenerateMedia(engine: Engine, job: GenerateMediaJob, ctx: JobHandlerContext): Promise<Record<string, unknown>> {
  const model = resolveModel(job.model);
  const adapter = adapterFor(model);
  requireApiKey(adapter.envKey);
  await engine.metadata.artifacts.write(job.assetId, "generation-request", job);
  const prompt = job.prompt === undefined ? undefined : applyPromptDialect(model.entry.dialect, job.prompt, job.refs);
  const durationError = (await checkInsertVideoTiming(engine, model, job.refs, job.options))
    ?? (await checkSeedanceEditSource(engine, model, job.refs, job.mode))
    ?? await checkRefDurations(engine, model, job.refs);
  if (durationError) throw new Error(durationError);
  const refs = await uploadRefs(engine, adapter, job.refs);
  const built = buildWireRequest(model, { prompt, refUrls: refs.urls, options: job.options, mode: job.mode });
  if (!built.ok) throw new Error(built.error);
  assertProviderPayload(built.request, { toolName: model.id, wire: true });
  await engine.metadata.artifacts.write(job.assetId, "generation-payload", storedPayload(model, built.request));
  const meta = { ...generationMeta(job, model, refs), ...(await replaceAudioMeta(engine, job.replaceAudioWith)) };
  const result = await adapter.submit(built.request, {
    engine,
    ctx,
    model,
    bookId: job.bookId,
    assetId: job.assetId,
    assetDir: job.assetDir,
    meta,
    costHints: await costHints(engine, refs, job),
  });
  if (result.kind === "done") {
    await completeMediaGeneration({ engine, assetId: job.assetId, assetDir: job.assetDir, bookId: job.bookId, meta, outputs: result.outputs });
  }
  return { success: true, model: model.id, taskId: result.taskId, status: result.kind };
}

export function registerGenerateMediaJob(engine: Engine): void {
  registerJobHandler("generate_media", (payload, ctx) => runGenerateMedia(engine, payload as GenerateMediaJob, ctx));
}
