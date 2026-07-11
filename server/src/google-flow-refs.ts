// Omni Flash reference-image budget math. A character ref may carry a trailing
// `-imgs:N` suffix minted by useapi.net indicating how many reference images it
// contributes (1 or 2); suffix-less refs contribute one. Image refs (image_slugs)
// each contribute one. The combined total must not exceed 7 (useapi.net R2V
// budget), or 5 alongside a reference clip (V2V).

const IMGS_SUFFIX = /-imgs:(\d+)$/;

/** Strip the `-imgs:N` suffix from a character ref to get its canonical ID. */
export function canonicalCharacterId(ref: string): string {
  return ref.replace(IMGS_SUFFIX, "");
}

/** Parse the useapi.net `-imgs:N` suffix on a character ref. Absent or
 *  malformed → 1; clamped to 1..2. */
export function characterRefImageCount(ref: string): number {
  const match = IMGS_SUFFIX.exec(ref);
  if (!match) return 1;
  const n = Number.parseInt(match[1], 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(1, n));
}

/** Total reference images for an omni-flash R2V request: image refs plus the
 *  per-character image counts. */
export function totalOmniReferenceImages(imageCount: number, characterRefs: string[]): number {
  const charImages = characterRefs.reduce(
    (sum, ref) => sum + characterRefImageCount(ref),
    0,
  );
  return imageCount + charImages;
}

export const OMNI_MAX_REFERENCE_IMAGES = 7;
export const OMNI_V2V_MAX_REFERENCE_IMAGES = 5;

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

/** Rewrite "@<slug>" mentions to the positional "@referenceImage_N" marker,
 *  where N is the slug's 1-based position in `imageSlugs` (the same order the
 *  payload builder assigns referenceImage_N body params from). */
export function rewriteImageSlugMentions(prompt: string, imageSlugs: readonly string[]): string {
  let out = prompt;
  for (const { slug, index } of slugMentionEntries(imageSlugs)) {
    out = out.replace(new RegExp(`@${escapeRe(slug)}(?![\\w-])`, "g"), `@referenceImage_${index + 1}`);
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
