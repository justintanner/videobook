export const PROMPT_SURFACES = [
  "chat",
  "image_rewrite",
  "script_rewrite",
  "post",
  "image_generate",
  "video_generate",
] as const;

export type PromptSurface = (typeof PROMPT_SURFACES)[number];
