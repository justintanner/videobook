import type { Engine } from "videobook-engine";
import type { MediaGenerationRequest, SunoGenerateRequest, SunoSoundsRequest } from "@apicity/kie";
import type { ElevenLabsComposeMusicRequest, ElevenLabsSoundGenerationRequest } from "@apicity/elevenlabs";
import { submitMediaJob } from "@apicity/kie";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";
import { createElevenLabs, createFal, createKie } from "../usage-providers.js";
import { resolveVideoRef } from "../tools/_seedance2-shared.js";
import { authorizeKiePaygate, ensurePaygateSecret, mintKieOtp } from "./kie-paygate.js";
import {
  audioGenerationModel,
  audioGenerationModels,
  buildAudioGenerationRequest,
  type AudioGenerationModel,
} from "../audio-generation-models.js";

export type AudioGenerationJobPayload = {
  type: string;
  toolName: string;
  bookId: string;
  audAssetId: string;
  args: Record<string, unknown>;
};

export type AudioProviderEndpoints = {
  elevenlabsBaseURL?: string;
  kieBaseURL?: string;
  falQueueBaseURL?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

type GeneratedAudio = {
  bytes: Buffer;
  extension: string;
  sourceUrl?: string;
  taskId?: string;
};

type RunContext = {
  engine: Engine;
  job: AudioGenerationJobPayload;
  model: AudioGenerationModel;
  request: Record<string, unknown>;
  signal: AbortSignal;
  endpoints: AudioProviderEndpoints;
  sourceVideoIds: string[];
};

const DEFAULT_TIMEOUT_MS = 25 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const SUNO_GENERATE_DOT_PATH = "api.v1.generate";
const SUNO_FAILURES = new Set(["CREATE_TASK_FAILED", "GENERATE_AUDIO_FAILED", "SENSITIVE_WORD_ERROR"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "opus", "flac", "m4a", "aac", "pcm"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function deadline(endpoints: AudioProviderEndpoints): number {
  return Date.now() + (endpoints.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

async function pause(context: RunContext): Promise<void> {
  await delay(context.endpoints.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, undefined, { signal: context.signal });
}

function timeoutError(context: RunContext, taskId: string): Error {
  return new Error(`${context.model.canonicalName} task ${taskId} did not finish in time`);
}

function extensionFromUrl(url: string): string | null {
  try {
    const match = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
    const extension = match?.[1]?.toLowerCase();
    return extension && AUDIO_EXTENSIONS.has(extension) ? extension : null;
  } catch {
    return null;
  }
}

function extensionFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "mp3";
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("ogg") || contentType.includes("opus")) return "ogg";
  if (contentType.includes("flac")) return "flac";
  if (contentType.includes("mp4") || contentType.includes("aac")) return "m4a";
  return null;
}

async function downloadAudio(url: string, signal: AbortSignal): Promise<GeneratedAudio> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Failed to download generated audio: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("Generated audio download was empty");
  const extension = extensionFromUrl(url) ?? extensionFromContentType(response.headers.get("content-type")) ?? "mp3";
  return { bytes, extension, sourceUrl: url };
}

function elevenLabsProvider(context: RunContext) {
  return createElevenLabs({
    apiKey: requireApiKey("ELEVENLABS_API_KEY"),
    timeout: 10 * 60_000,
    ...(context.endpoints.elevenlabsBaseURL ? { baseURL: context.endpoints.elevenlabsBaseURL } : {}),
  });
}

function kieProvider(context: RunContext) {
  return createKie({
    apiKey: requireApiKey("KIE_API_KEY"),
    timeout: 60_000,
    paygate: { secret: ensurePaygateSecret() },
    ...(context.endpoints.kieBaseURL ? { baseURL: context.endpoints.kieBaseURL } : {}),
  });
}

function falProvider(context: RunContext) {
  return createFal({
    apiKey: requireApiKey("FAL_API_KEY"),
    timeout: 60_000,
    ...(context.endpoints.falQueueBaseURL ? { queueBaseURL: context.endpoints.falQueueBaseURL } : {}),
  });
}

async function readVideoBlob(context: RunContext): Promise<Blob> {
  const ref = nonEmpty(context.job.args.video_ref);
  if (!ref) throw new Error("video_ref is required");
  const resolved = await resolveVideoRef(context.engine, ref);
  if (!resolved.ok) throw new Error(resolved.error);
  const dir = await context.engine.workspaces.resolveArtifact(resolved.value.assetId);
  if (!dir.ok) throw new Error(dir.error.message);
  context.sourceVideoIds.push(resolved.value.assetId);
  const bytes = await readFile(join(dir.value, resolved.value.filename));
  return new Blob([bytes], { type: "video/mp4" });
}

async function generateElevenLabs(context: RunContext): Promise<GeneratedAudio> {
  const provider = elevenLabsProvider(context);
  if (context.model.route === "elevenlabs_sound") {
    const audio = await provider.v1.soundGeneration(context.request as ElevenLabsSoundGenerationRequest, context.signal);
    return { bytes: Buffer.from(audio), extension: "mp3" };
  }
  if (context.model.route === "elevenlabs_music") {
    const audio = await provider.v1.music(context.request as ElevenLabsComposeMusicRequest, context.signal);
    return { bytes: Buffer.from(audio), extension: "mp3" };
  }
  const video = await readVideoBlob(context);
  const audio = await provider.v1.music.videoToMusic({ ...context.request, videos: [video] }, context.signal);
  return { bytes: Buffer.from(audio), extension: "mp3" };
}

function resultUrlsFromJson(resultJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    throw new Error("Kie returned invalid result JSON");
  }
  const root = record(parsed);
  for (const value of [root?.resultUrls, root?.result_urls, record(root?.resultObject)?.resultUrls]) {
    if (!Array.isArray(value)) continue;
    const urls = value.flatMap((entry) => nonEmpty(entry) ?? []);
    if (urls.length > 0) return urls;
  }
  throw new Error("Kie task finished without an audio URL");
}

async function pollKieTask(context: RunContext, provider: ReturnType<typeof createKie>, taskId: string): Promise<string> {
  const deadlineAt = deadline(context.endpoints);
  while (Date.now() < deadlineAt) {
    const result = await provider.get.api.v1.jobs.recordInfo(taskId);
    const state = result.data?.state?.toLowerCase();
    if (state === "success") return resultUrlsFromJson(result.data?.resultJson ?? "")[0]!;
    if (state === "fail" || state === "failed") {
      throw new Error(`Kie audio generation failed: ${result.data?.failMsg || result.data?.failCode || "unknown error"}`);
    }
    await pause(context);
  }
  throw timeoutError(context, taskId);
}

async function generateKieTask(context: RunContext): Promise<GeneratedAudio> {
  const provider = kieProvider(context);
  const request = context.request as unknown as MediaGenerationRequest;
  const { otp } = await authorizeKiePaygate(request, {
    engine: context.engine,
    correlation: {
      bookId: context.job.bookId,
      artifactId: context.job.audAssetId,
      tool: context.model.canonicalName,
      stage: "submit-kie-audio",
    },
  });
  const taskId = await submitMediaJob(provider, request, { otp });
  await context.engine.metadata.artifacts.write(context.job.audAssetId, "kie-task-id", { taskId });
  const url = await pollKieTask(context, provider, taskId);
  return { ...(await downloadAudio(url, context.signal)), taskId };
}

function sunoTrackUrl(tracks: Array<{ audioUrl?: string }> | undefined): string | null {
  for (const track of tracks ?? []) {
    const url = nonEmpty(track.audioUrl);
    if (url) return url;
  }
  return null;
}

async function pollSunoTask(context: RunContext, provider: ReturnType<typeof createKie>, taskId: string): Promise<string> {
  const deadlineAt = deadline(context.endpoints);
  while (Date.now() < deadlineAt) {
    const result = await provider.suno.get.api.v1.generate.recordInfo(taskId);
    const status = result.data?.status;
    const url = sunoTrackUrl(result.data?.response?.sunoData);
    if (url && (status === "SUCCESS" || status === "FIRST_SUCCESS" || status === "CALLBACK_EXCEPTION")) return url;
    if (status && SUNO_FAILURES.has(status)) {
      throw new Error(`Suno generation failed: ${result.data?.errorMessage || status}`);
    }
    await pause(context);
  }
  throw timeoutError(context, taskId);
}

async function submitSuno(context: RunContext, provider: ReturnType<typeof createKie>): Promise<string> {
  if (context.model.route === "suno_sounds") {
    const response = await provider.suno.post.api.v1.generate.sounds(context.request as unknown as SunoSoundsRequest);
    const taskId = nonEmpty(response.data?.taskId);
    if (!taskId) throw new Error(`Suno sounds submission failed: ${response.msg ?? response.code}`);
    return taskId;
  }
  const request = context.request as unknown as SunoGenerateRequest;
  const otp = mintKieOtp(request as unknown as MediaGenerationRequest, undefined, SUNO_GENERATE_DOT_PATH);
  const response = await provider.suno.post.api.v1.generate(request, { otp });
  const taskId = nonEmpty(response.data?.taskId);
  if (!taskId) throw new Error(`Suno submission failed: ${response.msg ?? response.code}`);
  return taskId;
}

async function generateSuno(context: RunContext): Promise<GeneratedAudio> {
  const provider = kieProvider(context);
  const taskId = await submitSuno(context, provider);
  await context.engine.metadata.artifacts.write(context.job.audAssetId, "kie-task-id", { taskId });
  const url = await pollSunoTask(context, provider, taskId);
  return { ...(await downloadAudio(url, context.signal)), taskId };
}

function falNamespace(endpointId: string): string {
  return endpointId.split("/").slice(0, 2).join("/");
}

function falAudioUrl(result: unknown): string | null {
  const root = record(result);
  const audio = record(root?.audio) ?? record(root?.audio_file);
  return nonEmpty(audio?.url) ?? nonEmpty(root?.audio_url);
}

async function pollFalTask(context: RunContext, provider: ReturnType<typeof createFal>, requestId: string): Promise<string> {
  const namespace = falNamespace(context.model.modelId);
  const deadlineAt = deadline(context.endpoints);
  while (Date.now() < deadlineAt) {
    const status = await provider.v1.queue.status({ endpoint_id: namespace, request_id: requestId });
    if (status.status === "COMPLETED") {
      if (status.error) throw new Error(`fal audio generation failed: ${status.error}`);
      const result = await provider.v1.queue.result({ endpoint_id: namespace, request_id: requestId });
      const url = falAudioUrl(result);
      if (!url) throw new Error(`${context.model.modelId} returned no audio`);
      return url;
    }
    await pause(context);
  }
  throw timeoutError(context, requestId);
}

async function generateFal(context: RunContext): Promise<GeneratedAudio> {
  const provider = falProvider(context);
  const submitted = await provider.post.v1.queue.submit({
    endpoint_id: context.model.modelId,
    input: context.request,
  } as Parameters<typeof provider.post.v1.queue.submit>[0]);
  await context.engine.metadata.artifacts.write(context.job.audAssetId, "kie-task-id", { taskId: submitted.request_id });
  const url = await pollFalTask(context, provider, submitted.request_id);
  return { ...(await downloadAudio(url, context.signal)), taskId: submitted.request_id };
}

function generateAudio(context: RunContext): Promise<GeneratedAudio> {
  switch (context.model.route) {
    case "elevenlabs_sound":
    case "elevenlabs_music":
    case "elevenlabs_video_to_music":
      return generateElevenLabs(context);
    case "kie_task":
      return generateKieTask(context);
    case "suno_music":
    case "suno_sounds":
      return generateSuno(context);
    case "fal_queue":
      return generateFal(context);
  }
}

async function toMp3(audio: GeneratedAudio): Promise<Buffer> {
  if (audio.extension === "mp3") return audio.bytes;
  const dir = await mkdtemp(join(tmpdir(), "videobook-audio-generation-"));
  try {
    const input = join(dir, `input.${audio.extension}`);
    const output = join(dir, "output.mp3");
    await writeFile(input, audio.bytes);
    await runFfmpeg(["-y", "-i", input, "-c:a", "libmp3lame", "-q:a", "2", output]);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function probeDuration(engine: Engine, assetId: string): Promise<number | undefined> {
  try {
    const dir = await engine.workspaces.resolveArtifact(assetId);
    if (!dir.ok) return undefined;
    const probe = await probeVideo(join(dir.value, "original.mp3"));
    return Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : undefined;
  } catch {
    return undefined;
  }
}

async function persistAudio(context: RunContext, audio: GeneratedAudio): Promise<number | undefined> {
  const mp3 = await toMp3(audio);
  const write = await context.engine.files.write(context.job.audAssetId, "original.mp3", mp3);
  if (!write.ok) throw new Error(`Failed to write original.mp3: ${write.error.message}`);
  return probeDuration(context.engine, context.job.audAssetId);
}

async function writeProvenance(context: RunContext, audio: GeneratedAudio, duration: number | undefined): Promise<void> {
  const prompt = typeof context.job.args.prompt === "string" ? context.job.args.prompt : "";
  const metadata = {
    origin: context.model.canonicalName,
    model: context.model.modelId,
    provider: context.model.provider,
    prompt,
    request: context.request,
    ...(context.sourceVideoIds.length > 0 ? { source_videos: context.sourceVideoIds } : {}),
    ...(audio.sourceUrl ? { download_url: audio.sourceUrl } : {}),
    ...(audio.taskId ? { task_id: audio.taskId } : {}),
    generated_at: new Date().toISOString(),
    ...(duration !== undefined ? { duration } : {}),
  };
  const written = await context.engine.metadata.artifacts.write(context.job.audAssetId, "original", metadata);
  if (!written.ok) throw new Error(`Failed to write artifact metadata: ${written.error.message}`);
}

export async function runAudioGeneration(
  engine: Engine,
  job: AudioGenerationJobPayload,
  signal: AbortSignal,
  endpoints: AudioProviderEndpoints = {},
): Promise<{ duration?: number }> {
  const model = audioGenerationModel(job.toolName);
  if (!model) throw new Error(`Unknown audio generation tool: ${job.toolName}`);
  const built = buildAudioGenerationRequest(model, job.args);
  if (!built.ok) throw new Error(built.error);
  const payloadWrite = await engine.metadata.artifacts.write(job.audAssetId, "generation-payload", built.request);
  if (!payloadWrite.ok) throw new Error(`Failed to write generation payload: ${payloadWrite.error.message}`);
  const context: RunContext = { engine, job, model, request: built.request, signal, endpoints, sourceVideoIds: [] };
  const audio = await generateAudio(context);
  const duration = await persistAudio(context, audio);
  await writeProvenance(context, audio, duration);
  return duration === undefined ? {} : { duration };
}

export function registerAudioGenerationJobs(engine: Engine): void {
  for (const model of audioGenerationModels()) {
    registerJobHandler(model.canonicalName, async (payload, ctx) => {
      ctx.getOwnerId();
      const result = await runAudioGeneration(engine, payload as AudioGenerationJobPayload, ctx.signal);
      return { success: true, provider: model.provider, ...result };
    });
  }
}
