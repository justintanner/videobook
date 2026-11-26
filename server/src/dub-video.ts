import type { CostEstimate } from "@apicity/cost";
import { resolveModel } from "./media/descriptor.js";
import { DUB_VIDEO_MAX_LANGUAGES, DUB_VIDEO_MODELS, DUB_VIDEO_RATES_USD_PER_SECOND, type DubQuality } from "./dub-video-contract.js";

export { DUB_VIDEO_MAX_LANGUAGES, DUB_VIDEO_MODELS, type DubQuality } from "./dub-video-contract.js";

export const DUB_VIDEO_MAX_DURATION_SECONDS = 480;
const DUB_VIDEO_RATE_AS_OF = "2026-10-23";

export type DubLanguageResolution =
  | { ok: true; languages: string[] }
  | { ok: false; error: string; candidates: string[] };

const MAX_CLOSE_CANDIDATES = 8;

export function isDubVideoModel(modelId: string | undefined): boolean {
  return modelId === DUB_VIDEO_MODELS.speed || modelId === DUB_VIDEO_MODELS.precision;
}

export function dubLanguageCandidates(quality: DubQuality = "speed"): readonly string[] {
  const model = resolveModel(DUB_VIDEO_MODELS[quality]);
  const option = model.options.find((candidate) => candidate.name === "output_language");
  return (option?.enumValues ?? []).filter((value): value is string => typeof value === "string");
}

function bareName(candidate: string): string | null {
  const index = candidate.indexOf(" (");
  return index > 0 ? candidate.slice(0, index) : null;
}

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

function closeLanguageCandidates(raw: string, candidates: readonly string[]): string[] {
  const query = normalizeSearch(raw);
  if (!query) return [];
  const tokens = query.split(/[\s(),/-]+/u).filter(Boolean);
  const scored: Array<{ candidate: string; tier: number; distance: number }> = [];
  for (const candidate of candidates) {
    const full = normalizeSearch(candidate);
    const bare = normalizeSearch(bareName(candidate) ?? candidate);
    if (bare === query) {
      scored.push({ candidate, tier: 0, distance: 0 });
      continue;
    }
    if (bare.startsWith(query) || full.startsWith(query)) {
      scored.push({ candidate, tier: 1, distance: Math.abs(bare.length - query.length) });
      continue;
    }
    if (full.includes(query) || (tokens.length > 0 && tokens.every((token) => full.includes(token)))) {
      scored.push({ candidate, tier: 2, distance: Math.abs(full.length - query.length) });
      continue;
    }
    const distance = Math.min(levenshtein(query, bare), levenshtein(query, full));
    const maxDistance = Math.max(2, Math.floor(Math.max(query.length, bare.length) * 0.4));
    if (distance <= maxDistance) {
      scored.push({ candidate, tier: 3, distance });
    }
  }
  return scored
    .sort((left, right) =>
      left.tier - right.tier
      || left.distance - right.distance
      || left.candidate.length - right.candidate.length
      || left.candidate.localeCompare(right.candidate))
    .slice(0, MAX_CLOSE_CANDIDATES)
    .map((entry) => entry.candidate);
}

type SingleMatch =
  | { kind: "match"; language: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "unknown"; candidates: string[] };

function matchSingleLanguage(raw: string, candidates: readonly string[]): SingleMatch {
  const trimmed = raw.trim();
  const exact = candidates.find((candidate) => candidate === trimmed);
  if (exact) return { kind: "match", language: exact };
  const lower = trimmed.toLowerCase();
  const folded = candidates.find((candidate) => candidate.toLowerCase() === lower);
  if (folded) return { kind: "match", language: folded };
  const bareMatches = candidates.filter((candidate) => bareName(candidate)?.toLowerCase() === lower);
  if (bareMatches.length === 1) return { kind: "match", language: bareMatches[0]! };
  if (bareMatches.length > 1) return { kind: "ambiguous", candidates: bareMatches.slice(0, MAX_CLOSE_CANDIDATES) };
  return { kind: "unknown", candidates: closeLanguageCandidates(trimmed, candidates) };
}

function splitLanguageList(raw: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let current = "";
  let index = 0;
  while (index < raw.length) {
    const char = raw[index]!;
    if (char === "(") {
      depth += 1;
      current += char;
      index += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
      index += 1;
      continue;
    }
    if (depth === 0) {
      if (char === ",") {
        pieces.push(current);
        current = "";
        const rest = raw.slice(index + 1);
        const oxford = /^\s*and(?=\s|$)/iu.exec(rest);
        index += 1 + (oxford ? oxford[0].length : 0);
        continue;
      }
      const conjunction = /^\s+and(?=\s)/iu.exec(raw.slice(index));
      if (conjunction) {
        pieces.push(current);
        current = "";
        index += conjunction[0].length;
        continue;
      }
    }
    current += char;
    index += 1;
  }
  pieces.push(current);
  return pieces.map((piece) => piece.trim()).filter(Boolean);
}

function singleMatchError(raw: string, result: Exclude<SingleMatch, { kind: "match" }>): DubLanguageResolution {
  const trimmed = raw.trim();
  if (result.kind === "ambiguous") {
    return {
      ok: false,
      error: `Language "${trimmed}" is ambiguous; pick one of: ${result.candidates.join(", ")}`,
      candidates: result.candidates,
    };
  }
  const suffix = result.candidates.length > 0
    ? ` Did you mean: ${result.candidates.join(", ")}?`
    : " Check list_generation_models for HeyGen Translate's output_language values.";
  return {
    ok: false,
    error: `Unknown language "${trimmed}".${suffix}`,
    candidates: result.candidates,
  };
}

export function resolveDubLanguages(
  input: string | readonly string[],
  candidates: readonly string[] = dubLanguageCandidates(),
): DubLanguageResolution {
  const entries = typeof input === "string" ? [input] : [...input];
  if (entries.length === 0) {
    return { ok: false, error: "At least one target language is required", candidates: [] };
  }
  const resolved: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) {
      return { ok: false, error: "Target language cannot be empty", candidates: [] };
    }
    const direct = matchSingleLanguage(trimmed, candidates);
    if (direct.kind === "match") {
      resolved.push(direct.language);
      continue;
    }
    if (direct.kind === "ambiguous") {
      return singleMatchError(trimmed, direct);
    }
    const pieces = splitLanguageList(trimmed);
    if (pieces.length <= 1) {
      return singleMatchError(trimmed, direct);
    }
    for (const piece of pieces) {
      const pieceMatch = matchSingleLanguage(piece, candidates);
      if (pieceMatch.kind !== "match") {
        return singleMatchError(piece, pieceMatch);
      }
      resolved.push(pieceMatch.language);
    }
  }
  const unique = [...new Set(resolved)];
  if (unique.length === 0) {
    return { ok: false, error: "At least one target language is required", candidates: [] };
  }
  if (unique.length > DUB_VIDEO_MAX_LANGUAGES) {
    return {
      ok: false,
      error: `Too many target languages (${unique.length}); dub_video accepts at most ${DUB_VIDEO_MAX_LANGUAGES} languages per call`,
      candidates: [],
    };
  }
  return { ok: true, languages: unique };
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
    ...(input.dynamicDuration !== undefined ? { enable_dynamic_duration: input.dynamicDuration } : {}),
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
