import { modelEntry } from "./catalog.js";

export const FRAME_ASPECT_DESCRIPTION = "Frame mode follows the first image’s aspect ratio (adaptive).";

interface FrameInput {
  generationMode?: unknown;
  mode?: unknown;
  refs?: unknown;
}

function hasFrameRefs(refs: unknown): boolean {
  if (refs === null || typeof refs !== "object" || Array.isArray(refs)) return false;
  const record = refs as Record<string, unknown>;
  return [record.first_frame, record.last_frame].some((value) =>
    (typeof value === "string" && value.trim() !== "")
    || (Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry.trim() !== "")));
}

export function frameAspectRatio(model: string, input: FrameInput): string | undefined {
  const aspect = modelEntry(model)?.frameOptions?.aspect_ratio;
  if (typeof aspect !== "string") return undefined;
  const mode = input.generationMode ?? input.mode;
  if (mode === "r2v") return undefined;
  return mode === "i2v" || hasFrameRefs(input.refs) ? aspect : undefined;
}
