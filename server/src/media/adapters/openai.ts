import { extname } from "node:path";
import type { OpenAiImageEditRequest, OpenAiImageGenerationRequest } from "@apicity/openai";
import type { Engine } from "videobook-engine";
import { createOpenAi } from "../../usage-providers.js";
import { requireApiKey } from "../../api-key.js";
import { providerEndpoints } from "../endpoints.js";
import { hasOpenAiImageSources } from "../openai.js";
import { assetRef, readAssetRef } from "./asset-ref.js";
import type { ProviderAdapter, SubmitContext, SubmitResult } from "./types.js";

const IMAGE_TIMEOUT_MS = 5 * 60_000;

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export interface OpenAiImageResult {
  taskId: string;
  outputs: Array<{ bytes: Buffer; extension: string }>;
}

function openAiImageProvider(timeout = IMAGE_TIMEOUT_MS, baseURL = providerEndpoints().openaiBaseURL): ReturnType<typeof createOpenAi> {
  return createOpenAi({
    apiKey: requireApiKey("OPENAI_API_KEY"),
    timeout,
    ...(baseURL ? { baseURL } : {}),
  });
}

async function readImageFile(engine: Engine, ref: string): Promise<File> {
  if (!ref.startsWith("asset://")) {
    throw new Error(`OpenAI image edits take images from this book, not a URL: ${ref}`);
  }
  const { bytes, filename } = await readAssetRef(engine, ref);
  const mimeType = MIME_TYPES[extname(filename).toLowerCase()];
  if (!mimeType) throw new Error(`OpenAI takes JPEG, PNG or WebP images, not ${filename}`);
  return new File([new Uint8Array(bytes)], filename, { type: mimeType });
}

export async function runOpenAiImage(
  engine: Engine,
  apiId: string,
  request: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<OpenAiImageResult> {
  const provider = openAiImageProvider(IMAGE_TIMEOUT_MS);
  const { images, mask, markup, ...rest } = request;
  const response = hasOpenAiImageSources(request)
    ? await provider.post.v1.images.edits({
      ...(rest as Omit<OpenAiImageEditRequest, "image" | "mask" | "markup">),
      image: await Promise.all((images as string[]).map((ref) => readImageFile(engine, ref))),
      ...(typeof mask === "string" && mask ? { mask: await readImageFile(engine, mask) } : {}),
      ...(typeof markup === "string" && markup ? { markup: await readImageFile(engine, markup) } : {}),
    }, signal)
    : await provider.post.v1.images.generations(rest as unknown as OpenAiImageGenerationRequest, signal);
  const extension = typeof request.output_format === "string" ? request.output_format : "png";
  const outputs = (response.data ?? []).flatMap((image) =>
    image.b64_json ? [{ bytes: Buffer.from(image.b64_json, "base64"), extension }] : []);
  if (outputs.length === 0) throw new Error(`OpenAI ${apiId} returned no image`);
  return { taskId: `${apiId}-${response.created}`, outputs };
}

export const openAiAdapter: ProviderAdapter = {
  provider: "openai",
  envKey: "OPENAI_API_KEY",
  upload: async (_engine, assetId, filename) => assetRef(assetId, filename),
  uploadUrl: async (url) => {
    throw new Error(`OpenAI image edits take images from this book, not a URL: ${url}`);
  },
  submit: async (request, context: SubmitContext): Promise<SubmitResult> => {
    const result = await runOpenAiImage(context.engine, context.model.apiId, request, context.ctx.signal);
    return { kind: "done", taskId: result.taskId, outputs: result.outputs };
  },
};
