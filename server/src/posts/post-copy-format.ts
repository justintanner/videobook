import type { PostPlatform } from "./post-contract.js";

export const POST_COPY_LANGUAGES = ["en", "th"] as const;
export type PostCopyLanguage = typeof POST_COPY_LANGUAGES[number];

export const POST_COPY_LANGUAGE_NAMES: Readonly<Record<PostCopyLanguage, string>> = { en: "English", th: "Thai" };

export const PLATFORM_CAPTION_LIMITS: Readonly<Record<PostPlatform, number>> = { x: 280, instagram: 2200, tiktok: 2200, youtube: 5000, other: 2200 };

export const PLATFORM_TAG_LIMITS: Readonly<Record<PostPlatform, number>> = { x: 2, instagram: 10, tiktok: 5, youtube: 15, other: 8 };

export const PLATFORM_NAMES: Readonly<Record<PostPlatform, string>> = { x: "X", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube Shorts", other: "Other" };

export type CaptionParts = { body: string; tags: string[] };

const TAG_TOKEN = /^#[\p{L}\p{M}\p{N}_]+$/u;

function normalizePostTag(value: string): string {
  return value.trim().replace(/^#+/u, "").replace(/[^\p{L}\p{M}\p{N}_]/gu, "");
}

export function normalizePostTags(values: readonly string[], limit = Number.POSITIVE_INFINITY): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of values) {
    const tag = normalizePostTag(value);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= limit) break;
  }
  return tags;
}

function isTagLine(line: string): boolean {
  const tokens = line.trim().split(/\s+/u);
  return tokens.length > 0 && tokens.every((token) => TAG_TOKEN.test(token));
}

export function splitCaptionTags(caption: string): CaptionParts {
  const trimmed = caption.trimEnd();
  const lines = trimmed.split("\n");
  const last = lines[lines.length - 1] ?? "";
  if (!last.trim() || !isTagLine(last)) return { body: caption, tags: [] };
  return { body: lines.slice(0, -1).join("\n").trimEnd(), tags: normalizePostTags(last.trim().split(/\s+/u)) };
}

export function joinCaptionTags(body: string, tags: readonly string[]): string {
  const line = normalizePostTags(tags).map((tag) => `#${tag}`).join(" ");
  const text = body.trimEnd();
  if (!line) return text;
  return text ? `${text}\n\n${line}` : line;
}
