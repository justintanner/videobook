// Omni Flash reference budget math. Google counts every reference input
// against one 7-slot pool (5 alongside a V2V clip): each image_slugs ref costs
// 1 slot, and each character costs a flat 2 — useapi.net submits every
// character entity twice in videoGenerationEntityInputs, regardless of its
// `-imgs:N` suffix or whether the prompt mentions it (verified empirically
// 2026-07-11 by replaying payloads: 3 chars + 1 image = 7 slots → 200, 4 chars
// + 1 image = 9 slots → opaque INVALID_ARGUMENT 400). Consequently at most 3
// characters ever fit an R2V request, and 2 alongside a clip.

const IMGS_SUFFIX = /-imgs:(\d+)$/;

/** Strip the `-imgs:N` suffix from a character ref to get its canonical ID. */
export function canonicalCharacterId(ref: string): string {
  return ref.replace(IMGS_SUFFIX, "");
}

/** Extract the `-imgs:N` count from a character ref, defaulting to 1 if omitted. */
export function characterRefImageCount(ref: string): number {
  const match = ref.match(IMGS_SUFFIX);
  return match ? parseInt(match[1], 10) : 1;
}

export const GOOGLE_IMAGE_MAX_REFERENCE_SLOTS = 10;

/** Total reference slots an image request consumes: image refs plus each
 *  character's actual image count. */
export function totalImageReferenceSlots(imageCount: number, characterRefs: string[]): number {
  return imageCount + characterRefs.reduce((acc, ref) => acc + characterRefImageCount(ref), 0);
}

export const OMNI_CHARACTER_SLOT_COST = 2;

/** Total reference slots an omni-flash request consumes: image refs plus a
 *  flat 2 per character. */
export function totalOmniReferenceSlots(imageCount: number, characterRefs: string[]): number {
  return imageCount + characterRefs.length * OMNI_CHARACTER_SLOT_COST;
}

export const OMNI_MAX_REFERENCE_SLOTS = 7;
export const OMNI_V2V_MAX_REFERENCE_SLOTS = 5;

// Google Flow prompts support inline positional mentions (@character_N,
// @referenceImage_N, @referenceAudio_N) that resolve to the matching body
// param — any other @-token the API cannot resolve is rejected with an opaque
// 400, so videocity @slug mentions must be rewritten (or removed) at submit.

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Mention boundary mirrors the client tokenizer (richPromptTokens): a slug
// mention ends at any char that is not a word char or dash, so "@img-da"
// never matches inside "@img-da-set". Longest slug first for the same reason.
function slugMentionEntries(slugs: readonly string[]): { slug: string; index: number }[] {
  return slugs
    .map((raw, index) => ({ slug: raw.replace(/^@/, "").trim(), index }))
    .filter((e) => e.slug !== "")
    .sort((a, b) => b.slug.length - a.slug.length);
}

/** Rewrite "@<slug>" mentions to a positional marker (e.g., "@referenceImage_N"),
 *  where N is the slug's 1-based position in `imageSlugs`. */
export function rewriteImageSlugMentions(prompt: string, imageSlugs: readonly string[], marker: string = "referenceImage"): string {
  let out = prompt;
  for (const { slug, index } of slugMentionEntries(imageSlugs)) {
    out = out.replace(new RegExp(`@${escapeRe(slug)}(?![\\w-])`, "g"), `@${marker}_${index + 1}`);
  }
  return out;
}

/** Remove "@<slug>" mentions that have no inline marker form (reference video
 *  clips, first frames) — the asset still rides its body param. */
export function stripSlugMentions(prompt: string, slugs: readonly string[]): string {
  let out = prompt;
  for (const { slug } of slugMentionEntries(slugs)) {
    out = out.replace(new RegExp(` ?@${escapeRe(slug)}(?![\\w-])`, "g"), "");
  }
  return out;
}

/** Replace "@<slug>" mentions with natural-language noun phrases for Kie
 *  happyhorse/video-edit and other free-form prompt models with no inline
 *  marker syntax (the "[Image N]" form belongs to happyhorse 1.1 t2v/i2v/ref
 *  only). The prompt is a free-form instruction; media rides separate URL
 *  fields. Rewrite confirmed @<video-slug> → "the source video", each
 *  @<image-slug> → "reference image N" (1-based in imageSlugs), and each
 *  @<audio-slug> → "reference audio N". Unlisted mentions stay literal. */
export function replaceHappyHorseAssetMentions(
  prompt: string,
  videoSlug: string | null,
  imageSlugs: readonly string[],
  audioSlugs: readonly string[] = [],
): string {
  let out = prompt;
  if (videoSlug) {
    const video = videoSlug.replace(/^@/, "").trim();
    if (video) {
      out = out.replace(new RegExp(`@${escapeRe(video)}(?![\\w-])`, "g"), "the source video");
    }
  }
  for (const { slug, index } of slugMentionEntries(imageSlugs)) {
    out = out.replace(
      new RegExp(`@${escapeRe(slug)}(?![\\w-])`, "g"),
      `reference image ${index + 1}`,
    );
  }
  for (const { slug, index } of slugMentionEntries(audioSlugs)) {
    out = out.replace(
      new RegExp(`@${escapeRe(slug)}(?![\\w-])`, "g"),
      `reference audio ${index + 1}`,
    );
  }
  return out;
}

/** HappyHorse 1.1 reference-to-video: rewrite confirmed @<image-slug> mentions
 *  to positional `[Image N]` markers matching the reference_image[] order. */
export function rewriteImageSlugMentionsToBrackets(
  prompt: string,
  imageSlugs: readonly string[],
): string {
  let out = prompt;
  for (const { slug, index } of slugMentionEntries(imageSlugs)) {
    out = out.replace(
      new RegExp(`@${escapeRe(slug)}(?![\\w-])`, "g"),
      `[Image ${index + 1}]`,
    );
  }
  return out;
}

export type SeedanceMentionSlugs = {
  imageSlugs?: readonly string[];
  videoSlugs?: readonly string[];
  audioSlugs?: readonly string[];
};

/** Seedance r2v: rewrite confirmed asset @slugs to `@ImageN` / `@VideoN` /
 *  `@AudioN` (1-based, matching upload order in each modality array). */
export function rewriteSeedanceAssetMentions(
  prompt: string,
  refs: SeedanceMentionSlugs,
): string {
  let out = prompt;
  for (const { slug, index } of slugMentionEntries(refs.imageSlugs ?? [])) {
    out = out.replace(
      new RegExp(`@${escapeRe(slug)}(?![\\w-])`, "g"),
      `@Image${index + 1}`,
    );
  }
  for (const { slug, index } of slugMentionEntries(refs.videoSlugs ?? [])) {
    out = out.replace(
      new RegExp(`@${escapeRe(slug)}(?![\\w-])`, "g"),
      `@Video${index + 1}`,
    );
  }
  for (const { slug, index } of slugMentionEntries(refs.audioSlugs ?? [])) {
    out = out.replace(
      new RegExp(`@${escapeRe(slug)}(?![\\w-])`, "g"),
      `@Audio${index + 1}`,
    );
  }
  return out;
}

/** Free-form multi-ref natural rewrite when the provider has no inline marker
 *  syntax: videos → "reference video N" (or "the source video" for a single
 *  source clip), images → "reference image N", audio → "reference audio N". */
export function replaceNaturalAssetMentions(
  prompt: string,
  refs: {
    sourceVideoSlug?: string | null;
    imageSlugs?: readonly string[];
    videoSlugs?: readonly string[];
    audioSlugs?: readonly string[];
  },
): string {
  let out = prompt;
  if (refs.sourceVideoSlug) {
    out = replaceHappyHorseAssetMentions(out, refs.sourceVideoSlug, [], []);
  }
  const multiVideos = refs.videoSlugs ?? [];
  for (const { slug, index } of slugMentionEntries(multiVideos)) {
    out = out.replace(
      new RegExp(`@${escapeRe(slug)}(?![\\w-])`, "g"),
      multiVideos.length === 1 ? "the source video" : `reference video ${index + 1}`,
    );
  }
  out = replaceHappyHorseAssetMentions(out, null, refs.imageSlugs ?? [], refs.audioSlugs ?? []);
  return out;
}
