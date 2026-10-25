import { createFal } from "../usage-providers.js";
import { submitMediaJob } from "../usage-providers.js";
import type { MediaGenerationRequest } from "@apicity/kie";
import { FalError } from "@apicity/fal";
import { SeedreamProImageToImageRequestSchema } from "@apicity/kie/zod";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import type { Engine } from "videobook-engine";
import { requireApiKey } from "../api-key.js";
import { IMAGE_EDIT_MODELS, type ImageEditModelInfo } from "../image-edit-models.js";
import { resolveModel } from "../media/descriptor.js";
import { buildWireRequest } from "../media/request.js";
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

const FAL_RESULT_TIMEOUT_MS = 25 * 60_000;

/** A provider request in the adapter's wire shape, safe to persist as `generation-payload`. */
export interface ImageEditProviderRequest {
  model: string;
  input: Record<string, unknown>;
}

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
  ): Promise<string>;
  awaitResult(taskId: string, signal: AbortSignal): Promise<Buffer[]>;
  /** Recognize this adapter's persisted `generation-payload`, if any. */
  parseStoredPayload(payload: unknown): ImageEditProviderRequest | null;
}

export const GROK_EXACT_MASK_ADAPTER_ID = "grok-imagine-image-2-0/image-edit";

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
  const aspect = model.options.find((option) => option.name === "aspect_ratio");
  const closest = closestAspectRatio(input.width, input.height);
  if (aspect?.enumValues.includes(closest)) options.aspect_ratio = closest;
  const format = model.options.find((option) => option.name === "output_format");
  if (format?.enumValues.includes("png")) options.output_format = "png";
  return options;
}

function catalogEditRequest(model: ResolvedModel, input: ImageEditRequestInput): Record<string, unknown> {
  const built = buildWireRequest(model, {
    prompt: input.prompt,
    refUrls: { image: [...input.imageUrls] },
    options: optionsFor(model, input),
  });
  if (!built.ok) throw new Error(built.error);
  return built.request;
}

function kieImageEditAdapter(model: ResolvedModel, build?: (input: ImageEditRequestInput) => ImageEditProviderRequest): ImageEditAdapter {
  const parse = (value: unknown) => model.wire.request.safeParse(value) as
    { success: true; data: MediaGenerationRequest } | { success: false };
  const buildRequest = build ?? ((input: ImageEditRequestInput) => {
    const request = catalogEditRequest(model, input) as unknown as MediaGenerationRequest;
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
      return taskId;
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
  const deadlineAt = Date.now() + FAL_RESULT_TIMEOUT_MS;
  for (;;) {
    if (Date.now() >= deadlineAt) {
      throw new Error(`Fal task ${taskId} did not finish within 25 minutes`);
    }
    let status;
    try {
      status = await provider.v1.queue.status({ endpoint_id: namespace, request_id: taskId });
    } catch (cause) {
      if (cause instanceof FalError && cause.status >= 400 && cause.status < 500) throw cause;
      await delay(Math.min(3_000, Math.max(1, deadlineAt - Date.now())), undefined, { signal });
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
    await delay(Math.min(3_000, Math.max(1, deadlineAt - Date.now())), undefined, { signal });
  }
}

function falImageEditAdapter(model: ResolvedModel): ImageEditAdapter {
  const parse = (value: unknown) => model.wire.input.safeParse(value);
  const buildRequest = (input: ImageEditRequestInput) =>
    toProviderRequest(model.apiId, catalogEditRequest(model, input));
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
      return submitted.request_id;
    },
    awaitResult: (taskId, signal) => awaitFalImages(model, taskId, signal),
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

function adapterForEditModel(info: ImageEditModelInfo): ImageEditAdapter {
  const model = resolveModel(info.catalogModel);
  if (info.provider === "fal") return falImageEditAdapter(model);
  if (model.apiId === "seedream/5-pro-image-to-image") return kieImageEditAdapter(model, seedreamRegionReplacementRequest);
  return kieImageEditAdapter(model);
}

export const IMAGE_EDIT_ADAPTERS: readonly ImageEditAdapter[] = IMAGE_EDIT_MODELS.map(adapterForEditModel);

export function imageEditAdapter(id: string): ImageEditAdapter | undefined {
  return IMAGE_EDIT_ADAPTERS.find((adapter) => adapter.id === id);
}
