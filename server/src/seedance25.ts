import type { MediaGenerationRequest } from "@apicity/kie";

export const SEEDANCE25_FRAME_ASPECT_DESCRIPTION = "Frame mode follows the first image’s aspect ratio (adaptive).";

interface Seedance25FrameInput {
  generationMode?: unknown;
  first_frame_ref?: unknown;
  last_frame_ref?: unknown;
  first_frame_url?: unknown;
  last_frame_url?: unknown;
}

export function seedance25FrameAspectRatio(
  tool: string,
  input: Seedance25FrameInput,
): "adaptive" | undefined {
  if (tool !== "generate_kie_seedance_2_5_video"
    && tool !== "generate_seedance25_video"
    && tool !== "bytedance/seedance-2-5") return undefined;
  const frames = [input.first_frame_ref, input.last_frame_ref, input.first_frame_url, input.last_frame_url];
  return input.generationMode === "i2v"
    || frames.some((frame) => typeof frame === "string" && frame.trim().length > 0)
    ? "adaptive"
    : undefined;
}

export function normalizeSeedance25Request(request: MediaGenerationRequest): MediaGenerationRequest {
  if (request.model !== "bytedance/seedance-2-5") return request;
  const aspectRatio = seedance25FrameAspectRatio(request.model, request.input);
  if (!aspectRatio || request.input.aspect_ratio === aspectRatio) return request;
  return { ...request, input: { ...request.input, aspect_ratio: aspectRatio } };
}
