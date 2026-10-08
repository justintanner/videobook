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

export type GenerationPromptSurface = Extract<
  PromptSurface,
  "image_generate" | "video_generate" | "audio_generate"
>;

const GENERATION_PROMPT_SURFACES: Readonly<Record<string, GenerationPromptSurface>> = {
  generate_image: "image_generate",
  generate_video: "video_generate",
  generate_audio: "audio_generate",
};

export function generationPromptSurface(
  cellType: string,
): GenerationPromptSurface | null {
  return GENERATION_PROMPT_SURFACES[cellType] ?? null;
}
