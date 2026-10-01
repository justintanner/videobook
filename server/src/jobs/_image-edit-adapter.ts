import { submitMediaJob } from "@apicity/kie";
import type { SeedreamProImageToImageRequest } from "@apicity/kie";
import { SeedreamProImageToImageRequestSchema } from "@apicity/kie/zod";
import sharp from "sharp";
import type { Engine } from "videobook-engine";
import { mintKieOtp } from "./kie-paygate.js";
import {
  KIE_RESULT_TIMEOUT_MS,
  kieProvider,
  parseResultUrls,
  waitForKieResult,
} from "./_kie-poll.js";

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
 * task whose payload parses as A's request schema.
 */
export interface ImageEditAdapter {
  readonly id: string;
  buildSemanticRequest(input: ImageEditRequestInput): ImageEditProviderRequest;
  buildRegionRequest(input: ImageEditRequestInput): ImageEditProviderRequest;
  submit(
    engine: Engine,
    imageAssetId: string,
    request: ImageEditProviderRequest,
    signal: AbortSignal,
  ): Promise<string>;
  awaitResult(taskId: string, signal: AbortSignal): Promise<Buffer[]>;
}

export const GROK_EXACT_MASK_ADAPTER_ID = "grok-imagine-image-2-0/image-edit";

function closestAspectRatio(
  width: number,
  height: number,
): SeedreamProImageToImageRequest["input"]["aspect_ratio"] {
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
}): SeedreamProImageToImageRequest {
  return SeedreamProImageToImageRequestSchema.parse({
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
}

function toProviderRequest(
  request: SeedreamProImageToImageRequest,
): ImageEditProviderRequest {
  return { model: request.model, input: { ...request.input } };
}

export const SEEDREAM_I2I_ADAPTER: ImageEditAdapter = {
  id: "seedream/5-pro-image-to-image",
  buildSemanticRequest: (input) =>
    toProviderRequest(SeedreamProImageToImageRequestSchema.parse({
      model: "seedream/5-pro-image-to-image",
      input: {
        image_urls: [input.imageUrls[0]!],
        prompt: input.prompt,
        aspect_ratio: closestAspectRatio(input.width, input.height),
        quality: "basic",
        output_format: "png",
        nsfw_checker: false,
      },
    })),
  buildRegionRequest: (input) =>
    toProviderRequest(seedreamRegionReplacementRequest({
      imageUrls: input.imageUrls,
      prompt: input.prompt,
      width: input.width,
      height: input.height,
    })),
  submit: async (engine, imageAssetId, request) => {
    const seedreamRequest = SeedreamProImageToImageRequestSchema.parse(request);
    const metadata = await engine.metadata.artifacts.write(
      imageAssetId,
      "generation-payload",
      seedreamRequest,
    );
    if (!metadata.ok) throw new Error(metadata.error.message);
    const taskId = await submitMediaJob(kieProvider(), seedreamRequest, {
      otp: mintKieOtp(seedreamRequest),
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
    const images: Buffer[] = [];
    for (const [index, url] of urls.entries()) {
      const response = await fetch(url, { signal });
      if (!response.ok) {
        throw new Error(
          `Failed to download Seedream edit ${index + 1}: ${response.status} ${response.statusText}`,
        );
      }
      images.push(await sharp(Buffer.from(await response.arrayBuffer())).png().toBuffer());
    }
    return images;
  },
};
