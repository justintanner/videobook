import { falContentRefusal } from "./_fal-shared.js";
import { createFal } from "../usage-providers.js";
import { submitMediaJob } from "../usage-providers.js";
import type { MediaGenerationRequest } from "@apicity/kie";
import { FalError } from "@apicity/fal";
import { MachGenError } from "@apicity/machgen";
import { WaveSpeedError, type WaveSpeedPrediction } from "@apicity/wavespeed";
import { SeedreamProImageToImageRequestSchema } from "@apicity/kie/zod";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import type { Engine } from "videobook-engine";
import { requireApiKey } from "../api-key.js";
import { IMAGE_EDIT_MODELS, type ImageEditModelInfo } from "../image-edit-models.js";
import { adapterFor } from "../media/adapters/index.js";
import { downloadMachGenOutput, machgenProvider } from "../media/adapters/machgen.js";
import { runGoogleImage } from "../media/adapters/google.js";
import { runGoogleFlowImage } from "../media/adapters/googleflow.js";
import { runNunchuxImage } from "../media/adapters/nunchux.js";
import { runOpenAiImage } from "../media/adapters/openai.js";
import { WAVESPEED_FAILED_STATUSES, wavespeedProvider } from "../media/adapters/wavespeed.js";
import { resolveModel } from "../media/descriptor.js";
import { providerEndpoints } from "../media/endpoints.js";
import { buildWireRequest } from "../media/request.js";
import { wavespeedMethod } from "../media/wavespeed.js";
import type { ResolvedModel } from "../media/types.js";
import { mintKieOtp } from "./kie-paygate.js";
import { uploadAssetToFal } from "./_fal-upload.js";
import { uploadAssetToKie } from "./_kie-upload.js";
import {
  KIE_RESULT_TIMEOUT_MS,
  kieProvider,
  parseResultUrls,
  waitForKieResult,
} from "./_kie-poll.js";

const PROVIDER_RESULT_TIMEOUT_MS = 25 * 60_000;
const POLL_INTERVAL_MS = 3_000;
const POLL_REQUEST_TIMEOUT_MS = 30_000;
const RETRYABLE_CLIENT_STATUSES = new Set([408, 429, 499]);

/** A provider request in the adapter's request shape, safe to persist as `generation-payload`. */
export interface ImageEditProviderRequest {
  model: string;
  input: Record<string, unknown>;
}

export type ImageEditSubmission =
  | { kind: "pending"; taskId: string }
  | { kind: "done"; taskId: string; images: Buffer[] };

export interface ImageEditRequestInput {
  /** [source image, ...identity/reference images] already uploaded to the provider. */
  imageUrls: readonly string[];
  prompt: string;
  width: number;
  height: number;
}

/**
 * One image-edit model behind the subject-edit job pipeline. Stored-task resume
 * is keyed on `id`: a job resumed with adapter A only reuses a stored provider
 * task whose payload A's `parseStoredPayload` recognizes.
 */
export interface ImageEditAdapter {
  readonly id: string;
  readonly envKey: ImageEditModelInfo["envKey"];
  /** Upload one artifact's current bytes to the provider and return a fetchable URL. */
  uploadAsset(engine: Engine, artifactId: string, filename: string): Promise<string>;
  buildSemanticRequest(input: ImageEditRequestInput): ImageEditProviderRequest;
  buildRegionRequest(input: ImageEditRequestInput): ImageEditProviderRequest;
  submit(
    engine: Engine,
    imageAssetId: string,
    request: ImageEditProviderRequest,
    signal: AbortSignal,
  ): Promise<ImageEditSubmission>;
  awaitResult(taskId: string, signal: AbortSignal): Promise<Buffer[]>;
  /** Recognize this adapter's persisted `generation-payload`, if any. */
  parseStoredPayload(payload: unknown): ImageEditProviderRequest | null;
}

export const GROK_EXACT_MASK_ADAPTER_ID = "grok-imagine-image-2-0/segment-edit";

function closestAspectRatio(
  width: number,
  height: number,
): "1:1" | "4:3" | "3:4" | "16:9" | "9:16" | "2:3" | "3:2" {
  const target = width / height;
  const candidates = [
    ["1:1", 1],
    ["4:3", 4 / 3],
    ["3:4", 3 / 4],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["2:3", 2 / 3],
    ["3:2", 3 / 2],
  ] as const;
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate[1] - target) < Math.abs(best[1] - target)
      ? candidate
      : best)[0];
}

export function seedreamRegionReplacementRequest(input: {
  imageUrls: readonly string[];
  prompt: string;
  width: number;
  height: number;
}): ImageEditProviderRequest {
  const parsed = SeedreamProImageToImageRequestSchema.parse({
    model: "seedream/5-pro-image-to-image",
    input: {
      image_urls: [...input.imageUrls],
      prompt: input.prompt,
      aspect_ratio: closestAspectRatio(input.width, input.height),
      quality: "basic",
      output_format: "png",
      nsfw_checker: false,
    },
  });
  return { model: parsed.model, input: { ...parsed.input } };
}

export async function downloadResultImages(
  urls: readonly string[],
  signal: AbortSignal,
  label: string,
): Promise<Buffer[]> {
  const images: Buffer[] = [];
  for (const [index, url] of urls.entries()) {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(
        `Failed to download ${label} ${index + 1}: ${response.status} ${response.statusText}`,
      );
    }
    images.push(await sharp(Buffer.from(await response.arrayBuffer())).png().toBuffer());
  }
  return images;
}

function toProviderRequest(
  model: string,
  input: Record<string, unknown>,
): ImageEditProviderRequest {
  return { model, input };
}

function falNamespace(endpointId: string): string {
  return endpointId.split("/").slice(0, 2).join("/");
}

function falResultImageUrls(resultObject: Record<string, unknown>): string[] {
  const images = resultObject.images;
  if (!Array.isArray(images)) return [];
  return images
    .map((image) => (typeof image === "object" && image !== null && "url" in image
      ? image.url
      : undefined))
    .filter((url): url is string => typeof url === "string");
}

function optionsFor(model: ResolvedModel, input: ImageEditRequestInput): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const aspect = model.options.find((option) => option.name === "aspect_ratio" || option.name === "aspectRatio");
  const closest = closestAspectRatio(input.width, input.height);
  if (aspect?.enumValues.includes(closest)) options[aspect.name] = closest;
  const size = model.options.find((option) => option.name === "size");
  const openAiSize = input.width > input.height ? "1536x1024" : input.width < input.height ? "1024x1536" : "1024x1024";
  if (size?.enumValues.includes(openAiSize)) options.size = openAiSize;
  const format = model.options.find((option) => option.name === "output_format");
  if (format?.enumValues.includes("png")) options.output_format = "png";
  return options;
}

function catalogEdit(model: ResolvedModel, input: ImageEditRequestInput): { request: Record<string, unknown>; input: Record<string, unknown> } {
  const built = buildWireRequest(model, {
    prompt: input.prompt,
    refUrls: { image: [...input.imageUrls] },
    options: optionsFor(model, input),
  });
  if (!built.ok) throw new Error(built.error);
  return { request: built.request, input: built.input };
}

function retryablePollError(cause: unknown): boolean {
  if (!(cause instanceof WaveSpeedError || cause instanceof MachGenError)) return false;
  return cause.status < 400 || cause.status >= 500 || RETRYABLE_CLIENT_STATUSES.has(cause.status);
}

function pollDelay(deadlineAt: number, signal: AbortSignal): Promise<void> {
  const interval = providerEndpoints().pollIntervalMs ?? POLL_INTERVAL_MS;
  return delay(Math.min(interval, Math.max(1, deadlineAt - Date.now())), undefined, { signal });
}

async function pngImages(images: readonly Buffer[]): Promise<Buffer[]> {
  return Promise.all(images.map((image) => sharp(image).png().toBuffer()));
}

function kieImageEditAdapter(model: ResolvedModel, build?: (input: ImageEditRequestInput) => ImageEditProviderRequest): ImageEditAdapter {
  const parse = (value: unknown) => model.wire.request.safeParse(value) as
    { success: true; data: MediaGenerationRequest } | { success: false };
  const buildRequest = build ?? ((input: ImageEditRequestInput) => {
    const request = catalogEdit(model, input).request as unknown as MediaGenerationRequest;
    return toProviderRequest(request.model, { ...(request.input as Record<string, unknown>) });
  });
  return {
    id: model.apiId,
    envKey: "KIE_API_KEY",
    uploadAsset: (engine, artifactId, filename) =>
      uploadAssetToKie(engine, artifactId, filename),
    buildSemanticRequest: (input) =>
      buildRequest({ ...input, imageUrls: [input.imageUrls[0]!] }),
    buildRegionRequest: buildRequest,
    submit: async (engine, imageAssetId, request) => {
      const parsed = parse(request);
      if (!parsed.success) throw new Error(`Invalid ${model.id} image edit request`);
      const metadata = await engine.metadata.artifacts.write(
        imageAssetId,
        "generation-payload",
        parsed.data,
      );
      if (!metadata.ok) throw new Error(metadata.error.message);
      const taskId = await submitMediaJob(kieProvider(), parsed.data, {
        otp: mintKieOtp(parsed.data),
      });
      const taskMetadata = await engine.metadata.artifacts.write(
        imageAssetId,
        "kie-task-id",
        { taskId },
      );
      if (!taskMetadata.ok) throw new Error(taskMetadata.error.message);
      return { kind: "pending", taskId };
    },
    awaitResult: async (taskId, signal) => {
      const resultJson = await waitForKieResult(
        kieProvider(),
        taskId,
        signal,
        Date.now() + KIE_RESULT_TIMEOUT_MS,
        "subject-edit",
      );
      const urls = parseResultUrls(resultJson);
      return downloadResultImages(urls, signal, `${model.apiId} edit`);
    },
    parseStoredPayload: (payload) => {
      const parsed = parse(payload);
      if (!parsed.success) return null;
      return toProviderRequest(parsed.data.model, { ...(parsed.data.input as Record<string, unknown>) });
    },
  };
}

async function awaitFalImages(model: ResolvedModel, taskId: string, signal: AbortSignal): Promise<Buffer[]> {
  const provider = createFal({ apiKey: requireApiKey("FAL_API_KEY"), timeout: 30_000 });
  const namespace = falNamespace(model.apiId);
  const deadlineAt = Date.now() + PROVIDER_RESULT_TIMEOUT_MS;
  for (;;) {
    if (Date.now() >= deadlineAt) {
      throw new Error(`Fal task ${taskId} did not finish within 25 minutes`);
    }
    let status;
    try {
      status = await provider.v1.queue.status({ endpoint_id: namespace, request_id: taskId });
    } catch (cause) {
      if (cause instanceof FalError && cause.status >= 400 && cause.status < 500) throw cause;
      await pollDelay(deadlineAt, signal);
      continue;
    }
    if (status.status === "COMPLETED") {
      if (status.error) {
        throw new Error(`Fal image edit failed: ${status.error}`);
      }
      const result = await provider.v1.queue.result({ endpoint_id: namespace, request_id: taskId });
      const urls = falResultImageUrls(result);
      if (urls.length === 0) throw new Error(`${model.apiId} image edit returned no image`);
      return downloadResultImages(urls, signal, `${model.apiId} edit`);
    }
    await pollDelay(deadlineAt, signal);
  }
}

function falImageEditAdapter(model: ResolvedModel): ImageEditAdapter {
  const parse = (value: unknown) => model.wire.input.safeParse(value);
  const buildRequest = (input: ImageEditRequestInput) =>
    toProviderRequest(model.apiId, catalogEdit(model, input).request);
  return {
    id: model.apiId,
    envKey: "FAL_API_KEY",
    uploadAsset: (engine, artifactId, filename) =>
      uploadAssetToFal(engine, artifactId, filename),
    buildSemanticRequest: (input) => buildRequest({ ...input, imageUrls: [input.imageUrls[0]!] }),
    buildRegionRequest: buildRequest,
    submit: async (engine, imageAssetId, request) => {
      const parsed = parse(request.input);
      if (!parsed.success) throw new Error(`Invalid ${model.id} image edit request`);
      const input = parsed.data as Record<string, unknown>;
      const provider = createFal({ apiKey: requireApiKey("FAL_API_KEY"), timeout: 60_000 });
      const metadata = await engine.metadata.artifacts.write(
        imageAssetId,
        "generation-payload",
        { endpoint_id: model.apiId, input },
      );
      if (!metadata.ok) throw new Error(metadata.error.message);
      const submitted = await provider.post.v1.queue.submit({ endpoint_id: model.apiId, input } as never);
      const taskMetadata = await engine.metadata.artifacts.write(
        imageAssetId,
        "kie-task-id",
        { taskId: submitted.request_id },
      );
      if (!taskMetadata.ok) throw new Error(taskMetadata.error.message);
      return { kind: "pending", taskId: submitted.request_id };
    },
    awaitResult: async (taskId, signal) => {
      try {
        return await awaitFalImages(model, taskId, signal);
      } catch (cause) {
        const refusal = falContentRefusal(cause, model.id);
        if (refusal) throw new Error(refusal.message, { cause });
        throw cause;
      }
    },
    parseStoredPayload: (payload) => {
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
      if (!("endpoint_id" in payload) || payload.endpoint_id !== model.apiId) return null;
      if (!("input" in payload)) return null;
      const parsed = parse(payload.input);
      if (!parsed.success) return null;
      return toProviderRequest(model.apiId, { ...(parsed.data as Record<string, unknown>) });
    },
  };
}

interface CatalogEditRunner {
  submit(engine: Engine, request: Record<string, unknown>, signal: AbortSignal): Promise<ImageEditSubmission>;
  awaitResult(taskId: string, signal: AbortSignal): Promise<Buffer[]>;
}

async function pollUntilSettled<T>(
  label: string,
  taskId: string,
  signal: AbortSignal,
  read: () => Promise<T>,
  settle: (status: T) => Promise<Buffer[]> | null,
): Promise<Buffer[]> {
  const deadlineAt = Date.now() + PROVIDER_RESULT_TIMEOUT_MS;
  for (;;) {
    if (Date.now() >= deadlineAt) throw new Error(`${label} task ${taskId} did not finish within 25 minutes`);
    let status: T | undefined;
    try {
      status = await read();
    } catch (cause) {
      if (!retryablePollError(cause)) throw cause;
    }
    const settled = status === undefined ? null : settle(status);
    if (settled) return settled;
    await pollDelay(deadlineAt, signal);
  }
}

function wavespeedRunner(model: ResolvedModel): CatalogEditRunner {
  const settle = (prediction: WaveSpeedPrediction, signal: AbortSignal): Promise<Buffer[]> | null => {
    if (WAVESPEED_FAILED_STATUSES.has(prediction.status)) {
      throw new Error(`WaveSpeed image edit failed: ${prediction.error || prediction.status}`);
    }
    if (prediction.status !== "completed") return null;
    const urls = (prediction.outputs ?? [])
      .filter((output): output is string => typeof output === "string" && /^https?:\/\//u.test(output));
    if (urls.length === 0) throw new Error(`${model.id} image edit returned no image`);
    return downloadResultImages(urls, signal, `${model.id} edit`);
  };
  return {
    submit: async (_engine, request, signal) => {
      const response = await wavespeedMethod(wavespeedProvider(), model.apiId)(request, signal);
      const taskId = response.data?.id;
      if (!taskId) throw new Error("WaveSpeed accepted the request without a prediction id");
      return { kind: "pending", taskId };
    },
    awaitResult: (taskId, signal) => {
      const provider = wavespeedProvider(POLL_REQUEST_TIMEOUT_MS);
      return pollUntilSettled("WaveSpeed", taskId, signal,
        async () => (await provider.api.v3.predictions.result(taskId, signal)).data,
        (prediction) => settle(prediction, signal));
    },
  };
}

function machgenRunner(model: ResolvedModel): CatalogEditRunner {
  const download = async (taskId: string): Promise<Buffer[]> => {
    const output = await downloadMachGenOutput(taskId, "image");
    if (!("bytes" in output)) throw new Error(`${model.id} image edit returned no image`);
    return pngImages([output.bytes]);
  };
  return {
    submit: async (_engine, request, signal) => {
      const response = await machgenProvider().api.v0.generate(request as never, signal);
      const taskId = response.task_id;
      if (!taskId) throw new Error("MachGen accepted the request without a task id");
      return { kind: "pending", taskId };
    },
    awaitResult: (taskId, signal) => {
      const provider = machgenProvider(POLL_REQUEST_TIMEOUT_MS);
      return pollUntilSettled("MachGen", taskId, signal,
        () => provider.api.v0.tasks(taskId, signal),
        (status) => {
          if (status.status === "FAILED") {
            throw new Error(`MachGen image edit failed: ${status.error_msg || "MachGen task failed"}`);
          }
          return status.status === "COMPLETED" ? download(taskId) : null;
        });
    },
  };
}

function nunchuxRunner(model: ResolvedModel): CatalogEditRunner {
  return {
    submit: async (engine, request, signal) => {
      const result = await runNunchuxImage(engine, model.apiId, request, signal);
      return { kind: "done", taskId: result.taskId, images: await pngImages(result.outputs.map((output) => output.bytes)) };
    },
    awaitResult: async (taskId) => {
      throw new Error(`Nunchux edit ${taskId} has no task to resume; run the edit again`);
    },
  };
}

function openAiRunner(model: ResolvedModel): CatalogEditRunner {
  return {
    submit: async (engine, request, signal) => {
      const result = await runOpenAiImage(engine, model.apiId, request, signal);
      return { kind: "done", taskId: result.taskId, images: await pngImages(result.outputs.map((output) => output.bytes)) };
    },
    awaitResult: async (taskId) => {
      throw new Error(`OpenAI edit ${taskId} has no task to resume; run the edit again`);
    },
  };
}

function googleRunner(model: ResolvedModel): CatalogEditRunner {
  return {
    submit: async (engine, request, signal) => {
      const result = await runGoogleImage(engine, model.apiId, request, signal);
      return { kind: "done", taskId: result.taskId, images: await pngImages(result.outputs.map((output) => output.bytes)) };
    },
    awaitResult: async (taskId) => {
      throw new Error(`Google edit ${taskId} has no task to resume; run the edit again`);
    },
  };
}

function googleFlowRunner(model: ResolvedModel): CatalogEditRunner {
  return {
    submit: async (_engine, request, signal) => {
      const result = await runGoogleFlowImage(model.apiId, request, signal);
      return { kind: "done", taskId: result.taskId, images: await downloadResultImages(result.urls, signal, `${model.id} edit`) };
    },
    awaitResult: async (taskId) => {
      throw new Error(`Google Flow edit ${taskId} has no task to resume; run the edit again`);
    },
  };
}

function catalogImageEditAdapter(
  model: ResolvedModel,
  info: ImageEditModelInfo,
  runner: CatalogEditRunner,
): ImageEditAdapter {
  const buildRequest = (input: ImageEditRequestInput) =>
    toProviderRequest(info.id, catalogEdit(model, input).input);
  const parseInput = (value: unknown) => {
    const parsed = model.wire.input.safeParse(value);
    return parsed.success ? parsed.data as Record<string, unknown> : null;
  };
  return {
    id: info.id,
    envKey: info.envKey,
    uploadAsset: (engine, artifactId, filename) =>
      adapterFor(model).upload(engine, artifactId, filename),
    buildSemanticRequest: (input) => buildRequest({ ...input, imageUrls: [input.imageUrls[0]!] }),
    buildRegionRequest: buildRequest,
    submit: async (engine, imageAssetId, request, signal) => {
      const input = parseInput(request.input);
      if (!input) throw new Error(`Invalid ${model.id} image edit request`);
      const wire = model.wire.request.parse(model.wire.wrap(input)) as Record<string, unknown>;
      const metadata = await engine.metadata.artifacts.write(
        imageAssetId,
        "generation-payload",
        { model: info.id, input },
      );
      if (!metadata.ok) throw new Error(metadata.error.message);
      const submitted = await runner.submit(engine, wire, signal);
      if (submitted.kind === "pending") {
        const taskMetadata = await engine.metadata.artifacts.write(
          imageAssetId,
          "kie-task-id",
          { taskId: submitted.taskId },
        );
        if (!taskMetadata.ok) throw new Error(taskMetadata.error.message);
      }
      return submitted;
    },
    awaitResult: (taskId, signal) => runner.awaitResult(taskId, signal),
    parseStoredPayload: (payload) => {
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
      if (!("model" in payload) || payload.model !== info.id || !("input" in payload)) return null;
      const input = parseInput(payload.input);
      return input ? toProviderRequest(info.id, input) : null;
    },
  };
}

function adapterForEditModel(info: ImageEditModelInfo): ImageEditAdapter {
  const model = resolveModel(info.catalogModel);
  switch (info.provider) {
    case "fal":
      return falImageEditAdapter(model);
    case "kie":
      return model.apiId === "seedream/5-pro-image-to-image"
        ? kieImageEditAdapter(model, seedreamRegionReplacementRequest)
        : kieImageEditAdapter(model);
    case "wavespeed":
      return catalogImageEditAdapter(model, info, wavespeedRunner(model));
    case "machgen":
      return catalogImageEditAdapter(model, info, machgenRunner(model));
    case "nunchux":
      return catalogImageEditAdapter(model, info, nunchuxRunner(model));
    case "openai":
      return catalogImageEditAdapter(model, info, openAiRunner(model));
    case "google":
      return catalogImageEditAdapter(model, info, googleRunner(model));
    case "googleflow":
      return catalogImageEditAdapter(model, info, googleFlowRunner(model));
  }
}

export const IMAGE_EDIT_ADAPTERS: readonly ImageEditAdapter[] = IMAGE_EDIT_MODELS.map(adapterForEditModel);

export function imageEditAdapter(id: string): ImageEditAdapter | undefined {
  return IMAGE_EDIT_ADAPTERS.find((adapter) => adapter.id === id);
}
