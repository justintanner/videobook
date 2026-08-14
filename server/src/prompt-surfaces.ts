export const PROMPT_SURFACES = [
  "chat",
  "image_rewrite",
  "video_rewrite",
  "script_rewrite",
  "post",
  "image_generate",
  "video_generate",
  "audio_generate",
] as const;

export type PromptSurface = (typeof PROMPT_SURFACES)[number];

export function isPromptSurface(value: unknown): value is PromptSurface {
  return (
    typeof value === "string" &&
    (PROMPT_SURFACES as ReadonlyArray<string>).includes(value)
  );
}
