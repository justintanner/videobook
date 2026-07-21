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
 *  happyhorse/video-edit. The 1.0 video-edit endpoint has NO inline marker
 *  syntax (the "[Image N]" form belongs to the 1.1 t2v/i2v/ref endpoints only)
 *  — the prompt is a free-form edit instruction, and the reference_image[]
 *  field carries the actual assets. To keep references unambiguous without
 *  leaking local asset IDs or implying a marker syntax the model doesn't
 *  understand, rewrite @<video-slug> to "the source video" and each
 *  @<image-slug> to "reference image N" preserving its 1-based position in
 *  imageSlugs. Mentions of slugs that aren't in the lists are left untouched. */
export function replaceHappyHorseAssetMentions(
  prompt: string,
  videoSlug: string | null,
  imageSlugs: readonly string[],
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
  return out;
}
