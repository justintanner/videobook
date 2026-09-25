import type { SubtitleStyle } from "./types.js";

const SUBTITLE_STYLES: readonly SubtitleStyle[] = ["impact", "highlight", "alive"];

export function isSubtitleStyle(value: unknown): value is SubtitleStyle {
  return typeof value === "string" && (SUBTITLE_STYLES as readonly string[]).includes(value);
}
