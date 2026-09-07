/**
 * The editorial vocabulary automatic tagging is allowed to emit.
 *
 * The engine normalizes labels into identities; it does not decide which words
 * are worth storing. That judgement lives here, because a tag only earns its
 * place if it helps someone — or a tool — find, group, match or sequence
 * footage. Letting each model invent its own grouping labels produces
 * "closeup", "close up" and "tight shot" on three different clips that should
 * have landed together, so standard terms are pinned to one canonical spelling
 * and everything outside the vocabulary is dropped rather than guessed at.
 *
 * The version below is part of the tag job's fence: bump it whenever the
 * vocabulary or the selection rules change meaningfully, and previously
 * tagged assets become eligible for a re-run.
 */

import { AUTOMATIC_TAGS_PER_SNAPSHOT_MAX, type TagFacet } from "videobook-engine";

export const TAG_ANALYZER_VERSION = "editorial-tags-v1";

/** The ceiling is a ceiling, never a quota: sparse evidence emits fewer. */
export const MAX_AUTOMATIC_TAGS = AUTOMATIC_TAGS_PER_SNAPSHOT_MAX;

export type TagCandidate = {
  facet: TagFacet;
  label: string;
};

type VocabularyEntry = {
  label: string;
  aliases: readonly string[];
};

/**
 * Visible composition and role. Named people never come from a model: a name
 * in a transcript does not identify who is on screen, so identities may only
 * arrive from user-confirmed project metadata.
 */
const PEOPLE: readonly VocabularyEntry[] = [
  { label: "no people", aliases: ["empty", "unpopulated", "nobody", "no one"] },
  { label: "solo subject", aliases: ["one person", "single person", "solo", "individual"] },
  { label: "two people", aliases: ["pair", "couple", "duo", "two subjects"] },
  { label: "small group", aliases: ["group", "three people", "few people", "small gathering"] },
  { label: "crowd", aliases: ["crowded", "many people", "audience", "large group"] },
  { label: "interviewer", aliases: ["host", "presenter", "questioner"] },
  { label: "interviewee", aliases: ["guest", "subject being interviewed", "respondent"] },
];

/** Settings useful for matching coverage, plus the two axes worth grouping by. */
const PLACES: readonly VocabularyEntry[] = [
  { label: "interior", aliases: ["indoors", "inside", "indoor"] },
  { label: "exterior", aliases: ["outdoors", "outside", "outdoor"] },
  { label: "day", aliases: ["daytime", "daylight", "morning", "afternoon"] },
  { label: "night", aliases: ["nighttime", "after dark", "evening"] },
  { label: "kitchen", aliases: ["galley"] },
  { label: "street", aliases: ["sidewalk", "roadside", "city street"] },
  { label: "studio", aliases: ["soundstage", "set"] },
  { label: "office", aliases: ["workplace", "desk"] },
  { label: "bedroom", aliases: [] },
  { label: "living room", aliases: ["lounge"] },
  { label: "restaurant", aliases: ["cafe", "diner", "bar"] },
  { label: "store", aliases: ["shop", "market", "supermarket"] },
  { label: "car", aliases: ["vehicle interior", "driving"] },
  { label: "beach", aliases: ["shore", "seaside"] },
  { label: "park", aliases: ["garden"] },
  { label: "forest", aliases: ["woods", "woodland"] },
  { label: "stage", aliases: ["venue", "concert stage"] },
  { label: "gym", aliases: ["fitness studio"] },
  { label: "rooftop", aliases: ["roof"] },
];

/**
 * Framing, supported camera movement, coverage and audio character. Movement
 * terms are only ever accepted from evidence that can actually establish them;
 * sparse, evenly spaced frames cannot, so the extractors do not offer them.
 */
const EDITING: readonly VocabularyEntry[] = [
  { label: "wide shot", aliases: ["wide", "long shot", "full shot", "establishing wide"] },
  { label: "medium shot", aliases: ["medium", "mid shot", "waist up"] },
  { label: "close-up", aliases: ["close up", "closeup", "tight shot", "cu"] },
  { label: "extreme close-up", aliases: ["extreme close up", "extreme closeup", "macro shot"] },
  { label: "establishing shot", aliases: ["establishing", "scene setter"] },
  { label: "insert", aliases: ["insert shot", "cutaway", "detail shot"] },
  { label: "product shot", aliases: ["product", "packshot"] },
  { label: "static", aliases: ["locked off", "tripod", "still camera", "fixed camera"] },
  { label: "pan", aliases: ["panning", "whip pan"] },
  { label: "tilt", aliases: ["tilting"] },
  { label: "handheld", aliases: ["hand held", "shaky", "run and gun"] },
  { label: "tracking", aliases: ["dolly", "steadicam", "follow shot", "tracking shot"] },
  { label: "interview", aliases: ["talking head", "sit down interview"] },
  { label: "dialogue", aliases: ["conversation", "speech", "talking"] },
  { label: "ambience", aliases: ["ambient", "room tone", "atmosphere", "background sound"] },
  { label: "music", aliases: ["musical", "score", "soundtrack"] },
  { label: "voiceover", aliases: ["voice over", "narration", "narrator"] },
];

const VOCABULARY: Readonly<Record<TagFacet, readonly VocabularyEntry[]>> = {
  people: PEOPLE,
  places: PLACES,
  editing: EDITING,
  // Automatic tagging never mints custom tags; that facet is the user's.
  custom: [],
};

/**
 * Words that describe how footage feels or how good it is. They group nothing:
 * every clip in a project can be "beautiful", and no editor searches for it.
 */
const BANNED_TERMS: ReadonlySet<string> = new Set([
  "beautiful", "stunning", "amazing", "gorgeous", "great", "good", "nice",
  "cool", "epic", "dramatic", "moody", "vibe", "vibes", "aesthetic", "mood",
  "cinematic", "masterpiece", "high quality", "professional", "hd", "4k",
  "video", "footage", "clip", "content", "scene", "shot", "media", "image",
  "photo", "picture", "frame", "camera", "misc", "other", "general",
  "interesting", "modern", "classic", "colorful", "bright", "dark",
  "atmospheric", "emotional", "energetic", "calm", "peaceful", "happy", "sad",
]);

function normalizeTerm(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_/]+/gu, " ")
    .replace(/[^\p{L}\p{N}\s-]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

const ALIAS_INDEX: ReadonlyMap<string, TagCandidate> = new Map(
  (Object.entries(VOCABULARY) as Array<[TagFacet, readonly VocabularyEntry[]]>)
    .flatMap(([facet, entries]) =>
      entries.flatMap((entry) =>
        [entry.label, ...entry.aliases].map((term) =>
          [`${facet}:${normalizeTerm(term)}`, { facet, label: entry.label }] as const)))
);

/** Every canonical label a facet may carry, for prompts and documentation. */
export function vocabularyFor(facet: TagFacet): string[] {
  return VOCABULARY[facet].map((entry) => entry.label);
}

/**
 * A place the vocabulary does not list can still be worth keeping — "subway",
 * "rooftop bar" — but only when it reads as a concrete setting rather than an
 * impression. One or two plain words, nothing banned, nothing numeric.
 */
function acceptsUnlistedPlace(term: string): boolean {
  if (BANNED_TERMS.has(term)) return false;
  const words = term.split(" ");
  if (words.length === 0 || words.length > 2) return false;
  return words.every((word) =>
    word.length >= 3 && word.length <= 20 && /^[\p{L}-]+$/u.test(word));
}

/**
 * Maps one raw term onto the vocabulary, or rejects it. People and editing are
 * closed sets: an unrecognized term there is a model inventing a grouping
 * label, which is exactly what the vocabulary exists to prevent.
 *
 * `allowUnlisted` opens the places facet to settings the vocabulary does not
 * list, and belongs only where the caller knows the term is a setting — a
 * model that labelled it `places`, or the analysis field that holds nothing
 * else. Offered speculatively it would accept anything short: try "cooking" as
 * a place and it becomes one.
 */
export function canonicalizeTag(
  facet: TagFacet,
  raw: string,
  options: { allowUnlisted?: boolean } = {},
): TagCandidate | null {
  const term = normalizeTerm(raw);
  if (!term || term.length > 40) return null;
  const known = ALIAS_INDEX.get(`${facet}:${term}`);
  if (known) return known;
  if (options.allowUnlisted && facet === "places" && acceptsUnlistedPlace(term)) {
    return { facet, label: term };
  }
  return null;
}

/**
 * Finds vocabulary terms inside a phrase. Analysis fields are written as prose
 * — "A domestic kitchen", "shot handheld on a busy street" — so a whole-string
 * match would discard almost everything useful. Matching is on word
 * boundaries, so "interior" is found in "interior hallway" while "day" is not
 * found in "daydream".
 */
export function matchVocabularyTerms(
  facet: TagFacet,
  phrase: string,
): TagCandidate[] {
  const text = normalizeTerm(phrase);
  if (!text) return [];
  const matches: TagCandidate[] = [];
  for (const entry of VOCABULARY[facet]) {
    for (const term of [entry.label, ...entry.aliases]) {
      const normalized = normalizeTerm(term);
      if (!normalized) continue;
      const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}])${normalized.replace(/[-]/gu, "[- ]")}(?![\\p{L}\\p{N}])`,
        "u",
      );
      if (pattern.test(text)) {
        matches.push({ facet, label: entry.label });
        break;
      }
    }
  }
  return matches;
}

/**
 * Final selection: canonical identities, no duplicates across facets, capped.
 * Order is preserved because extractors offer their best-supported evidence
 * first, so a cap trims the weakest claims rather than an arbitrary tail.
 */
export function selectEditorialTags(
  candidates: readonly TagCandidate[],
  limit = MAX_AUTOMATIC_TAGS,
): TagCandidate[] {
  const selected: TagCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    // Candidates reaching selection have already been vetted by an extractor,
    // so an unlisted place here is one that was accepted upstream.
    const canonical = canonicalizeTag(candidate.facet, candidate.label, {
      allowUnlisted: true,
    });
    if (!canonical) continue;
    const identity = `${canonical.facet}:${normalizeTerm(canonical.label)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    selected.push(canonical);
  }
  return selected;
}
