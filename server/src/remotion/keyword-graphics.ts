import { parseSegments } from "./subtitles/segments.js";
import type { KeywordGraphic, Segment, Word } from "./subtitles/types.js";

export const DEFAULT_KEYWORD_GRAPHICS_MAX_COUNT = 8;
export const DEFAULT_KEYWORD_GRAPHICS_LINGER_SECONDS = 2.4;

const STOP_WORDS = new Set([
  "and", "are", "can", "did", "for", "get", "got", "had", "has", "her", "his", "how", "its",
  "know", "not", "now", "one", "our", "said", "say", "see", "she", "take", "tell", "the", "too",
  "two", "way", "well", "why", "yes", "you",
  "about", "after", "again", "against", "almost", "also", "always", "among", "another", "around",
  "because", "been", "before", "being", "between", "both", "but", "came", "come", "could",
  "does", "doing", "done", "down", "during", "each", "even", "every", "from", "going", "have",
  "having", "here", "hers", "him", "himself", "into", "just", "like", "made", "make", "many",
  "might", "more", "most", "much", "must", "never", "only", "other", "ours", "over", "really",
  "same", "should", "since", "some", "still", "such", "than", "that", "their", "them", "then",
  "there", "these", "they", "thing", "think", "this", "those", "through", "under", "until", "very",
  "want", "was", "were", "what", "when", "where", "which", "while", "who", "will", "with", "would",
  "your", "you're", "youre",
]);

interface KeywordGraphicsOptions {
  maxCount?: number;
  lingerSeconds?: number;
}

export interface RequestedKeywordGraphicsResult {
  graphics: KeywordGraphic[];
  missing: string[];
}

interface Candidate {
  display: string;
  normalized: string;
  start: number;
  end: number;
  score: number;
}

function transcriptPayload(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (Array.isArray(value.transcripts)) {
    const transcript = value.transcripts.find(
      (entry) => typeof entry === "object" && entry !== null,
    );
    return transcript ? transcript as Record<string, unknown> : null;
  }
  return value;
}

export function parseKeywordTranscript(raw: unknown): Segment[] {
  const payload = transcriptPayload(raw);
  return payload ? parseSegments(payload) : [];
}

function cleanWord(raw: string): string {
  return raw.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function wordLength(value: string): number {
  return Array.from(value).filter((char) => /[\p{L}\p{N}]/u.test(char)).length;
}

function isCandidateWord(display: string, normalized: string): boolean {
  const length = wordLength(display);
  if (length < 3 && !/^[\p{Lu}\d]{2,}$/u.test(display)) return false;
  if (STOP_WORDS.has(normalized)) return false;
  if (/^\d+$/.test(normalized) && length < 4) return false;
  return true;
}

function timedWords(segments: Segment[]): Word[] {
  return segments
    .flatMap((segment) => segment.words)
    .filter((word) => (
      Number.isFinite(word.start)
      && Number.isFinite(word.end)
      && word.start >= 0
      && word.end >= word.start
    ));
}

function buildCandidates(segments: Segment[]): Candidate[] {
  const words = timedWords(segments);
  const frequencies = new Map<string, number>();
  for (const word of words) {
    const display = cleanWord(word.word);
    const normalized = display.toLocaleLowerCase();
    if (!isCandidateWord(display, normalized)) continue;
    frequencies.set(normalized, (frequencies.get(normalized) ?? 0) + 1);
  }

  return words.flatMap((word) => {
    const display = cleanWord(word.word);
    const normalized = display.toLocaleLowerCase();
    if (!isCandidateWord(display, normalized)) return [];
    const lengthScore = Math.min(14, wordLength(display)) * 0.3;
    const frequencyScore = Math.min(4, frequencies.get(normalized) ?? 1) * 1.15;
    const titleScore = /^[\p{Lu}]/u.test(display) ? 0.35 : 0;
    return [{
      display,
      normalized,
      start: word.start,
      end: word.end,
      score: lengthScore + frequencyScore + titleScore,
    }];
  });
}

function pickCandidates(candidates: Candidate[], maxCount: number, lingerSeconds: number): Candidate[] {
  const minGap = lingerSeconds + 0.75;
  const selected: Candidate[] = [];
  const used = new Set<string>();
  const ranked = [...candidates].sort((a, b) => b.score - a.score || a.start - b.start);

  for (const candidate of ranked) {
    if (used.has(candidate.normalized)) continue;
    if (selected.some((entry) => Math.abs(entry.start - candidate.start) < minGap)) continue;
    selected.push(candidate);
    used.add(candidate.normalized);
    if (selected.length >= maxCount) break;
  }

  return selected.sort((a, b) => a.start - b.start);
}

function graphicsFromCandidates(candidates: Candidate[], lingerSeconds: number): KeywordGraphic[] {
  const selected = [...candidates].sort((a, b) => a.start - b.start);
  return selected.map((candidate, index) => {
    const start = Math.max(0, candidate.start - 0.12);
    const nextStart = selected[index + 1]?.start;
    const desiredEnd = Math.max(candidate.end + lingerSeconds, start + 1.2);
    const end = nextStart === undefined ? desiredEnd : Math.min(desiredEnd, nextStart - 0.18);
    return {
      text: candidate.display,
      start,
      end: Math.max(start + 0.01, end),
      side: index % 2 === 0 ? "right" : "left",
      frameTime: (candidate.start + candidate.end) / 2,
    };
  });
}

export function selectKeywordGraphics(
  segments: Segment[],
  options: KeywordGraphicsOptions = {},
): KeywordGraphic[] {
  const maxCount = Math.min(20, Math.max(1, Math.floor(options.maxCount ?? DEFAULT_KEYWORD_GRAPHICS_MAX_COUNT)));
  const lingerSeconds = Math.min(5, Math.max(0.8, options.lingerSeconds ?? DEFAULT_KEYWORD_GRAPHICS_LINGER_SECONDS));
  const selected = pickCandidates(buildCandidates(segments), maxCount, lingerSeconds);

  return graphicsFromCandidates(selected, lingerSeconds);
}

export function selectRequestedKeywordGraphics(
  segments: Segment[],
  requestedKeywords: string[],
  options: Pick<KeywordGraphicsOptions, "lingerSeconds"> = {},
): RequestedKeywordGraphicsResult {
  const lingerSeconds = Math.min(5, Math.max(0.8, options.lingerSeconds ?? DEFAULT_KEYWORD_GRAPHICS_LINGER_SECONDS));
  const words = timedWords(segments).map((word) => ({
    display: cleanWord(word.word),
    normalized: cleanWord(word.word).toLocaleLowerCase(),
    start: word.start,
    end: word.end,
    score: 0,
  }));
  const selected: Candidate[] = [];
  const missing: string[] = [];
  const used = new Set<string>();

  for (const requested of requestedKeywords) {
    const display = cleanWord(requested);
    const normalized = display.toLocaleLowerCase();
    if (!display || used.has(normalized)) continue;
    used.add(normalized);
    const match = words.find((word) => word.normalized === normalized);
    if (!match) {
      missing.push(display);
      continue;
    }
    selected.push({ ...match, display });
  }

  return {
    graphics: graphicsFromCandidates(selected, lingerSeconds),
    missing,
  };
}
