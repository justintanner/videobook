export const PROMPT_SURFACES = [
  "chat",
  "image_rewrite",
  "script_rewrite",
  "post",
] as const;

export type PromptSurface = (typeof PROMPT_SURFACES)[number];
