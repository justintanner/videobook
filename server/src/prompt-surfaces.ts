export const PROMPT_SURFACES = [
  "chat",
  "image_rewrite",
  "script_rewrite",
  "post",
] as const;

export type PromptSurface = (typeof PROMPT_SURFACES)[number];

export function isPromptSurface(value: unknown): value is PromptSurface {
  return (
    typeof value === "string" &&
    (PROMPT_SURFACES as ReadonlyArray<string>).includes(value)
  );
}
