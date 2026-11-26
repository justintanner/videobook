import type { CostEstimate } from "@apicity/cost";
import { resolveModel } from "./media/descriptor.js";
import { DUB_VIDEO_MODELS, DUB_VIDEO_RATES_USD_PER_SECOND, type DubQuality } from "./dub-video-contract.js";
import { bareName, normalizeSearch, resolveDubLanguagesFrom, type DubLanguageResolution } from "./dub-video-languages.js";

export { DUB_VIDEO_MAX_LANGUAGES, DUB_VIDEO_MODELS, type DubQuality } from "./dub-video-contract.js";
export type { DubLanguageResolution } from "./dub-video-languages.js";

export const DUB_VIDEO_MAX_DURATION_SECONDS = 480;
const DUB_VIDEO_RATE_AS_OF = "2026-10-23";

export function isDubVideoModel(modelId: string | undefined): boolean {
  return modelId === DUB_VIDEO_MODELS.speed || modelId === DUB_VIDEO_MODELS.precision;
}

export function dubLanguageCandidates(quality: DubQuality = "speed"): readonly string[] {
  const model = resolveModel(DUB_VIDEO_MODELS[quality]);
  const option = model.options.find((candidate) => candidate.name === "output_language");
  return (option?.enumValues ?? []).filter((value): value is string => typeof value === "string");
}

export function resolveDubLanguages(
  input: string | readonly string[],
  candidates: readonly string[] = dubLanguageCandidates(),
): DubLanguageResolution {
  return resolveDubLanguagesFrom(input, candidates);
}

type LanguageMention = { start: number; end: number; name: string };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function languageSearchNames(candidates: readonly string[]): Array<{ folded: string; name: string }> {
  const names = new Map<string, string>();
  for (const candidate of candidates) {
    for (const name of [candidate, bareName(candidate)]) {
      const folded = name ? normalizeSearch(name) : "";
      if (folded && !names.has(folded)) names.set(folded, name!);
    }
  }
  return [...names]
    .map(([folded, name]) => ({ folded, name }))
    .sort((left, right) => right.folded.length - left.folded.length);
}

export function dubLanguageMentions(
  text: string,
  candidates: readonly string[] = dubLanguageCandidates(),
): string[] {
  const haystack = normalizeSearch(text);
  const mentions: LanguageMention[] = [];
  for (const { folded, name } of languageSearchNames(candidates)) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(folded)}(?![\\p{L}\\p{N}])`, "gu");
    for (const match of haystack.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (/\bfrom\s+$/u.test(haystack.slice(0, start))) continue;
      if (mentions.some((mention) => start < mention.end && mention.start < end)) continue;
      mentions.push({ start, end, name });
    }
  }
  return [...new Set(mentions
    .sort((left, right) => left.start - right.start)
    .map((mention) => mention.name))];
}

export function dubGenerationOptions(input: {
  language: string;
  lipSync: boolean;
  speakers?: number;
  dynamicDuration?: boolean;
}): Record<string, unknown> {
  return {
    output_language: input.language,
    translate_audio_only: !input.lipSync,
    ...(input.speakers !== undefined ? { speaker_num: input.speakers } : {}),
    enable_dynamic_duration: input.dynamicDuration ?? false,
  };
}

export function estimateDubCost(input: {
  durationSeconds: number;
  languageCount: number;
  quality: DubQuality;
  dynamicDuration?: boolean;
}): CostEstimate {
  const billedSeconds = Math.ceil(input.durationSeconds);
  const rate = DUB_VIDEO_RATES_USD_PER_SECOND[input.quality];
  const units = billedSeconds * input.languageCount;
  const usd = Math.round(units * rate * 1_000_000) / 1_000_000;
  const endpoint = DUB_VIDEO_MODELS[input.quality].slice("fal:".length);
  const languageClause = input.languageCount > 1 ? ` across ${input.languageCount} languages` : "";
  const dynamicClause = input.dynamicDuration === true
    ? " (especially with dynamic_duration enabled)"
    : " (more so with dynamic_duration)";
  return {
    usd,
    currency: "USD",
    source: "per-unit-table",
    breakdown: {
      units,
      unit: "seconds",
      perUnitUsd: rate,
    },
    rateAsOf: DUB_VIDEO_RATE_AS_OF,
    warnings: [
      `fal '${endpoint}': prices the source video's ${billedSeconds}s${languageClause} at $${rate.toFixed(2)}/s; HeyGen bills whole seconds of output video, which can differ from the source${dynamicClause}, so this estimate is a lower bound`,
    ],
  };
}
