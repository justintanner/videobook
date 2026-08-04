/**
 * Display labels for generated artifacts.
 *
 * Labels are free text: never parsed, never matched, never a lookup key.
 * They exist so a person scanning the library can tell one render from
 * another, so they read as prose rather than as the hyphenated identifiers
 * the old slug scheme required.
 */

const MAX_SUMMARY_CHARS = 60;

/** Collapse a prompt to a short, readable fragment. */
export function promptSummary(
  prompt: string | undefined,
  maxChars: number = MAX_SUMMARY_CHARS,
): string {
  const text = (prompt ?? "").replace(/\s+/gu, " ").trim();
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > maxChars / 2 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

/**
 * Label for a generation output, e.g.
 * `kling-3.0/video — a cat dancing in the rain`.
 * Falls back to the model alone when there is no prompt to summarize.
 */
export function generationLabel(model: string, prompt?: string): string {
  const summary = promptSummary(prompt);
  return summary ? `${model} — ${summary}` : model;
}

/**
 * Label for an artifact derived from another one, e.g.
 * `upscaled — beach sunset`. `source` is the upstream artifact's label,
 * falling back to its id when it has none.
 */
export function derivedLabel(operation: string, source: string | undefined): string {
  const stem = (source ?? "").trim();
  return stem ? `${operation} — ${stem}` : operation;
}
