import { createFal } from "../usage-providers.js";
import { submitMediaJob } from "@apicity/kie";
import type { MediaGenerationRequest } from "@apicity/kie";
import type { FalEndpointId, FalEndpointInputMap } from "@apicity/fal";
import type { FalQueueSubmitRequest } from "@apicity/fal/zod";
import { FalError } from "@apicity/fal";
import {
  FalAlibabaQwenImage3EditRequestSchema,
  FalNanoBanana2EditRequestSchema,
  FalNanoBananaProEditRequestSchema,
  FalWanV2p7EditRequestSchema,
} from "@apicity/fal/zod";
import {
  GptImage2ImageToImageRequestSchema,
  SeedreamProImageToImageRequestSchema,
} from "@apicity/kie/zod";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import type { Engine } from "videobook-engine";
import { requireApiKey } from "../api-key.js";
import { buildGptImage25Payload, GPT_IMAGE_2_5_MODELS } from "../gpt-image-2-5.js";
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

type KieImageEditRequestSchema = {
  parse(value: unknown): MediaGenerationRequest;
  safeParse(value: unknown): { success: true; data: MediaGenerationRequest } | { success: false; error: unknown };
};

type FalImageEditInputSchema<T> = {
  parse(value: unknown): T;
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown };
};

/**
 * One image-edit model behind the subject-edit job pipeline. Stored-task resume
 * is keyed on `id`: a job resumed with adapter A only reuses a stored provider
 * task whose payload A's `parseStoredPayload` recognizes.
 */
export interface ImageEditAdapter {
  readonly id: string;
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

function kieImageEditAdapter(args: {
  id: string;
  requestSchema: KieImageEditRequestSchema;
  build(input: ImageEditRequestInput): ImageEditProviderRequest;
}): ImageEditAdapter {
  return {
    id: args.id,
    uploadAsset: (engine, artifactId, filename) =>
      uploadAssetToKie(engine, artifactId, filename),
    buildSemanticRequest: (input) =>
      args.build({ ...input, imageUrls: [input.imageUrls[0]!] }),
    buildRegionRequest: args.build,
    submit: async (engine, imageAssetId, request) => {
      const parsed = args.requestSchema.parse(request);
      const metadata = await engine.metadata.artifacts.write(
        imageAssetId,
        "generation-payload",
        parsed,
      );
      if (!metadata.ok) throw new Error(metadata.error.message);
      const taskId = await submitMediaJob(kieProvider(), parsed, {
        otp: mintKieOtp(parsed),
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
      return downloadResultImages(urls, signal, `${args.id} edit`);
    },
    parseStoredPayload: (payload) => {
      const parsed = args.requestSchema.safeParse(payload);
      if (!parsed.success) return null;
      return toProviderRequest(parsed.data.model, { ...parsed.data.input });
    },
  };
}

function falImageEditAdapter<Id extends FalEndpointId>(args: {
  id: Id;
  inputSchema: FalImageEditInputSchema<FalEndpointInputMap[Id]>;
  build(input: ImageEditRequestInput): FalEndpointInputMap[Id];
}): ImageEditAdapter {
  return {
    id: args.id,
    uploadAsset: (engine, artifactId, filename) =>
      uploadAssetToFal(engine, artifactId, filename),
    buildSemanticRequest: (input) => {
      const parsed = args.inputSchema.parse(
        args.build({ ...input, imageUrls: [input.imageUrls[0]!] }),
      );
      return toProviderRequest(args.id, { ...parsed });
    },
    buildRegionRequest: (input) => {
      const parsed = args.inputSchema.parse(args.build(input));
      return toProviderRequest(args.id, { ...parsed });
    },
    submit: async (engine, imageAssetId, request) => {
      const input = args.inputSchema.parse(request.input);
      const provider = createFal({ apiKey: requireApiKey("FAL_API_KEY"), timeout: 60_000 });
      const metadata = await engine.metadata.artifacts.write(
        imageAssetId,
        "generation-payload",
        { endpoint_id: args.id, input },
      );
      if (!metadata.ok) throw new Error(metadata.error.message);
      // FalQueueSubmitRequest's conditional input type cannot see the generic Id here.
      const params = { endpoint_id: args.id, input } as FalQueueSubmitRequest<Id>;
      const submitted = await provider.post.v1.queue.submit(params);
      const taskMetadata = await engine.metadata.artifacts.write(
        imageAssetId,
        "kie-task-id",
        { taskId: submitted.request_id },
      );
      if (!taskMetadata.ok) throw new Error(taskMetadata.error.message);
      return submitted.request_id;
    },
    awaitResult: async (taskId, signal) => {
      const provider = createFal({ apiKey: requireApiKey("FAL_API_KEY"), timeout: 30_000 });
      const namespace = falNamespace(args.id);
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
          if (urls.length === 0) throw new Error(`${args.id} image edit returned no image`);
          return downloadResultImages(urls, signal, `${args.id} edit`);
        }
        await delay(Math.min(3_000, Math.max(1, deadlineAt - Date.now())), undefined, { signal });
      }
    },
    parseStoredPayload: (payload) => {
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
      if (!("endpoint_id" in payload) || payload.endpoint_id !== args.id) return null;
      if (!("input" in payload)) return null;
      const parsed = args.inputSchema.safeParse(payload.input);
      if (!parsed.success) return null;
      return toProviderRequest(args.id, { ...parsed.data });
    },
  };
}

function falEditBuild(
  input: ImageEditRequestInput,
  maxPromptLength?: number,
): { prompt: string; image_urls: string[] } {
  if (maxPromptLength !== undefined && input.prompt.length > maxPromptLength) {
    throw new Error(
      `This model accepts prompts of at most ${maxPromptLength} characters; the composed edit prompt is ${input.prompt.length} characters.`,
    );
  }
  return { prompt: input.prompt, image_urls: [...input.imageUrls] };
}

const gptImage25EditAdapter = (variant: keyof typeof GPT_IMAGE_2_5_MODELS): ImageEditAdapter => {
  const config = GPT_IMAGE_2_5_MODELS[variant];
  return kieImageEditAdapter({
    id: config.editSchema.shape.model.value,
    requestSchema: config.editSchema,
    build: (input) => {
      const request = buildGptImage25Payload(
        variant,
        {
          prompt: input.prompt,
          aspect_ratio: closestAspectRatio(input.width, input.height),
        },
        [...input.imageUrls],
      );
      return toProviderRequest(request.model, { ...request.input });
    },
  });
};

export const SEEDREAM_I2I_ADAPTER: ImageEditAdapter = kieImageEditAdapter({
  id: "seedream/5-pro-image-to-image",
  requestSchema: SeedreamProImageToImageRequestSchema,
  build: seedreamRegionReplacementRequest,
});

export const IMAGE_EDIT_ADAPTERS: readonly ImageEditAdapter[] = [
  SEEDREAM_I2I_ADAPTER,
  gptImage25EditAdapter("flare"),
  gptImage25EditAdapter("sunburst"),
  kieImageEditAdapter({
    id: GptImage2ImageToImageRequestSchema.shape.model.value,
    requestSchema: GptImage2ImageToImageRequestSchema,
    build: (input) => {
      const parsed = GptImage2ImageToImageRequestSchema.parse({
        model: "gpt-image-2-image-to-image",
        input: {
          prompt: input.prompt,
          input_urls: [...input.imageUrls],
          aspect_ratio: closestAspectRatio(input.width, input.height),
        },
      });
      return toProviderRequest(parsed.model, { ...parsed.input });
    },
  }),
  falImageEditAdapter({
    id: "fal-ai/nano-banana-pro/edit",
    inputSchema: FalNanoBananaProEditRequestSchema,
    build: (input) => falEditBuild(input),
  }),
  falImageEditAdapter({
    id: "fal-ai/nano-banana-2/edit",
    inputSchema: FalNanoBanana2EditRequestSchema,
    build: (input) => falEditBuild(input),
  }),
  falImageEditAdapter({
    id: "alibaba/qwen-image-3/edit",
    inputSchema: FalAlibabaQwenImage3EditRequestSchema,
    build: (input) => falEditBuild(input),
  }),
  falImageEditAdapter({
    id: "fal-ai/wan/v2.7/edit",
    inputSchema: FalWanV2p7EditRequestSchema,
    build: (input) => falEditBuild(input, 500),
  }),
];

export function imageEditAdapter(id: string): ImageEditAdapter | undefined {
  return IMAGE_EDIT_ADAPTERS.find((adapter) => adapter.id === id);
}
