/**
 * Turning analysis a book already paid for into editorial tags.
 *
 * Nothing here calls a provider. Image analysis, video analysis and
 * transcripts are produced elsewhere and cached on the artifact; this module
 * reads that evidence and decides what it actually supports. Two rules shape
 * every extractor:
 *
 * 1. An unsupported claim is omitted, not softened. Evenly spaced frames can
 *    show a setting and a framing; they cannot establish that the camera
 *    tracked, so no extractor offers movement from them.
 * 2. Absence of evidence is a state, not an empty tag set to hide. Callers get
 *    an outcome they can report, so "we found nothing useful" never looks the
 *    same as "we never looked".
 */

import type { TagFacet } from "videobook-engine";
import {
  canonicalizeTag,
  isFrameTag,
  matchVocabularyTerms,
  selectEditorialTags,
  type TagCandidate,
} from "./tag-vocabulary.js";

type TagExtractionOutcome =
  /** Evidence existed and produced at least one tag. */
  | "tagged"
  /** Evidence existed but supported nothing worth grouping by. */
  | "no_useful_evidence"
  /** No analysis is cached for this artifact yet. */
  | "no_evidence"
  /** This artifact kind carries nothing automatic tagging can read. */
  | "unsupported_kind";

export type TagExtraction = {
  tags: TagCandidate[];
  outcome: TagExtractionOutcome;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap(strings);
}

function result(tags: TagCandidate[]): TagExtraction {
  const selected = selectEditorialTags(tags);
  return {
    tags: selected,
    outcome: selected.length > 0 ? "tagged" : "no_useful_evidence",
  };
}

/**
 * Structured records the vision model returned in the same request that
 * produced the reproduction prompt. Anything outside the vocabulary is
 * dropped here rather than trusted.
 */
export type StructuredTagRecord = {
  facet?: unknown;
  label?: unknown;
};

function structuredCandidates(value: unknown): TagCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = record(entry);
    const facet = typeof row?.facet === "string" ? row.facet : null;
    const label = typeof row?.label === "string" ? row.label : null;
    if (!facet || !label) return [];
    const canonical = canonicalizeTag(facet as TagFacet, label, {
      allowUnlisted: true,
    });
    return canonical ? [canonical] : [];
  });
}

/**
 * Images: the describe_image response carries structured tags alongside the
 * reproduction prompt, so tagging costs no extra request. A cached analysis
 * written before tags existed simply yields nothing — the shot/pose fields
 * are prompt vocabulary, not grouping terms, and mining them would invent
 * claims the model never made.
 */
export function tagsFromImageAnalysis(analysis: unknown): TagExtraction {
  const document = record(analysis);
  if (!document || !Array.isArray(document.tags)
    || (document.tags.length > 0 && !document.tags.some((entry) => {
      const tag = record(entry);
      return typeof tag?.facet === "string" && ["people", "places", "editing"].includes(tag.facet)
        && typeof tag.label === "string";
    }))) return { tags: [], outcome: "no_evidence" };
  return result(structuredCandidates(document.tags).filter(isFrameTag));
}

/**
 * Video and final renders: analyze_video's cached document. Its `tags`,
 * `setting`, `subjects` and scene tags are free text written for search, so
 * every term goes through the vocabulary and most are discarded. A fallback
 * document — the empty shape the analyzer writes when the provider failed —
 * is not evidence at all.
 */
export function tagsFromVideoAnalysis(analysis: unknown): TagExtraction {
  const document = record(analysis);
  if (!document) return { tags: [], outcome: "no_evidence" };
  if (isFallbackAnalysis(document)) return { tags: [], outcome: "no_evidence" };
  if (Array.isArray(document.editorialTags)) {
    return result(structuredCandidates(document.editorialTags).filter(isFrameTag));
  }

  const scenes = Array.isArray(document.scenes) ? document.scenes : [];
  const sceneTags = scenes.flatMap((scene) => strings(record(scene)?.tags));
  // Setting first: where something happens is the most reliable grouping
  // signal a frame sample supports, then who is in it, then the analyzer's
  // own top-level terms, then per-scene detail.
  const settings = strings(document.setting);
  const freeText = [
    ...strings(document.tags),
    ...sceneTags,
  ];
  const candidates = [
    // The setting field holds a place and nothing else, so a concrete term it
    // names is kept even when the vocabulary has never seen it.
    ...settings.flatMap((phrase) => {
      const listed = matchVocabularyTerms("places", phrase);
      if (listed.length > 0) return listed;
      const unlisted = canonicalizeTag("places", phrase, { allowUnlisted: true });
      return unlisted ? [unlisted] : [];
    }),
    ...freeText.flatMap((phrase) =>
      (["places", "people", "editing"] as const).flatMap((facet) => {
        const exact = canonicalizeTag(facet, phrase);
        return exact ? [exact] : [];
      })),
    ...strings(document.subjects).flatMap((phrase) => {
      const exact = canonicalizeTag("people", phrase);
      return exact ? [exact] : [];
    }),
  ];
  return result(candidates.filter(isFrameTag));
}

/**
 * An analyze_video run that failed writes a document with every field empty.
 * Blessing that as "analyzed, nothing found" would fence the artifact against
 * a later successful run, so it counts as no evidence.
 */
export function isFallbackAnalysis(document: Record<string, unknown>): boolean {
  const summary = typeof document.summary === "string" ? document.summary.trim() : "";
  const scenes = Array.isArray(document.scenes) ? document.scenes.length : 0;
  const tags = Array.isArray(document.tags) ? document.tags.length : 0;
  const subjects = Array.isArray(document.subjects) ? document.subjects.length : 0;
  const setting = typeof document.setting === "string" ? document.setting.trim() : "";
  return summary === "" && scenes === 0 && tags === 0 && subjects === 0 && setting === "";
}

export type TranscriptEvidence = {
  /** Words the transcript actually carries, across all segments. */
  wordCount: number;
  /** Distinct speakers the transcript identified, when it labels them. */
  speakerCount: number;
};

/**
 * Audio: what a transcript can honestly support is whether the recording
 * carries speech and whether more than one person speaks. Topic and genre are
 * not editing decisions, and a name in a transcript identifies nobody on
 * screen, so neither becomes a tag.
 */
export function tagsFromTranscript(evidence: TranscriptEvidence | null): TagExtraction {
  if (!evidence) return { tags: [], outcome: "no_evidence" };
  const candidates: TagCandidate[] = [];
  if (evidence.wordCount > 0) candidates.push({ facet: "editing", label: "dialogue" });
  return result(candidates);
}

/**
 * Text-bearing artifacts. A script's sluglines are the one place stored text
 * genuinely encodes place and time — "INT. KITCHEN - NIGHT" is a structured
 * statement, not a keyword that happens to appear. Everything else in a
 * document is dialogue and direction, which say nothing about how the footage
 * that may one day exist was shot, so nothing else is read.
 */
export function tagsFromScriptText(text: string | null): TagExtraction {
  if (!text || !text.trim()) return { tags: [], outcome: "no_evidence" };
  const candidates: TagCandidate[] = [];
  const sluglines = text.match(/^\s*(INT|EXT)[.\s][^\n]*/gimu) ?? [];
  for (const line of sluglines) {
    const upper = line.toUpperCase();
    if (/^\s*INT/u.test(upper)) candidates.push({ facet: "places", label: "interior" });
    if (/^\s*EXT/u.test(upper)) candidates.push({ facet: "places", label: "exterior" });
    if (/[-\s]DAY\b/u.test(upper)) candidates.push({ facet: "places", label: "day" });
    if (/[-\s]NIGHT\b/u.test(upper)) candidates.push({ facet: "places", label: "night" });
  }
  if (candidates.length === 0) return { tags: [], outcome: "no_useful_evidence" };
  return result(candidates);
}
