import {
  normalizeNotebookReference,
  replaceNotebookMentions,
  stripNotebookMentions,
} from "videobook-engine/notebook-mentions";

// Omni Flash reference budget math. Google counts every reference input
// against one 7-slot pool (5 alongside a V2V clip): each image_refs ref costs
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
// 400, so local @<artifact-id> mentions must be rewritten (or removed) at
// submit.

// Mention boundary: a reference ends at any char that is not a word char or
// dash, so "@a1" never matches inside "@a10". Longest reference first for the
// same reason.
function refMentionEntries(refs: readonly string[]): { ref: string; index: number }[] {
  return refs
    .map((raw, index) => ({
      ref: normalizeNotebookReference(raw),
      index,
    }))
    .filter((e) => e.ref !== "")
    .sort((a, b) => b.ref.length - a.ref.length);
}

/** Rewrite "@<ref>" mentions to a positional marker (e.g., "@referenceImage_N"),
 *  where N is the ref's 1-based position in `imageRefs`. */
export function rewriteImageRefMentions(prompt: string, imageRefs: readonly string[], marker: string = "referenceImage"): string {
  return replaceNotebookMentions(
    prompt,
    refMentionEntries(imageRefs).map(({ ref, index }) => ({
      reference: ref,
      replacement: `@${marker}_${index + 1}`,
    })),
  );
}

/** Remove "@<ref>" mentions that have no inline marker form (reference video
 *  clips, first frames) — the asset still rides its body param. */
export function stripRefMentions(prompt: string, refs: readonly string[]): string {
  return stripNotebookMentions(
    prompt,
    refMentionEntries(refs).map(({ ref }) => ref),
  );
}

/** Replace "@<ref>" mentions with natural-language noun phrases for Kie
 *  happyhorse/video-edit and other free-form prompt models with no inline
 *  marker syntax (the "[Image N]" form belongs to happyhorse 1.1 t2v/i2v/ref
 *  only). The prompt is a free-form instruction; media rides separate URL
 *  fields. Rewrite confirmed @<video-ref> → "the source video", each
 *  @<image-ref> → "reference image N" (1-based in imageRefs), and each
 *  @<audio-ref> → "reference audio N". Unlisted mentions stay literal. */
export function replaceHappyHorseAssetMentions(
  prompt: string,
  videoRef: string | null,
  imageRefs: readonly string[],
  audioRefs: readonly string[] = [],
): string {
  const replacements: Array<{ reference: string; replacement: string }> = [];
  if (videoRef) {
    const video = normalizeNotebookReference(videoRef);
    if (video) {
      replacements.push({ reference: video, replacement: "the source video" });
    }
  }
  for (const { ref, index } of refMentionEntries(imageRefs)) {
    replacements.push({
      reference: ref,
      replacement: `reference image ${index + 1}`,
    });
  }
  for (const { ref, index } of refMentionEntries(audioRefs)) {
    replacements.push({
      reference: ref,
      replacement: `reference audio ${index + 1}`,
    });
  }
  return replaceNotebookMentions(prompt, replacements);
}

/** HappyHorse 1.1 reference-to-video: rewrite confirmed @<image-ref> mentions
 *  to positional `[Image N]` markers matching the reference_image[] order. */
export function rewriteImageRefMentionsToBrackets(
  prompt: string,
  imageRefs: readonly string[],
): string {
  return replaceNotebookMentions(
    prompt,
    refMentionEntries(imageRefs).map(({ ref, index }) => ({
      reference: ref,
      replacement: `[Image ${index + 1}]`,
    })),
  );
}

type SeedanceMentionRefs = {
  imageRefs?: readonly string[];
  videoRefs?: readonly string[];
  audioRefs?: readonly string[];
};

/** Seedance r2v: rewrite confirmed asset @refs to `@ImageN` / `@VideoN` /
 *  `@AudioN` (1-based, matching upload order in each modality array). */
export function rewriteSeedanceAssetMentions(
  prompt: string,
  refs: SeedanceMentionRefs,
): string {
  const replacements: Array<{ reference: string; replacement: string }> = [];
  for (const { ref, index } of refMentionEntries(refs.imageRefs ?? [])) {
    replacements.push({ reference: ref, replacement: `@Image${index + 1}` });
  }
  for (const { ref, index } of refMentionEntries(refs.videoRefs ?? [])) {
    replacements.push({ reference: ref, replacement: `@Video${index + 1}` });
  }
  for (const { ref, index } of refMentionEntries(refs.audioRefs ?? [])) {
    replacements.push({ reference: ref, replacement: `@Audio${index + 1}` });
  }
  return replaceNotebookMentions(prompt, replacements);
}

export function rewriteViduReferenceMentions(
  prompt: string,
  imageRefs: readonly string[],
  audioRefs: readonly string[],
): string {
  return replaceNotebookMentions(prompt, [
    ...refMentionEntries(imageRefs).map(({ ref, index }) => ({
      reference: ref,
      replacement: `[@reference_image_${index + 1}]`,
    })),
    ...refMentionEntries(audioRefs).map(({ ref, index }) => ({
      reference: ref,
      replacement: `[reference_audio_${index + 1}]`,
    })),
  ]);
}

/** Free-form multi-ref natural rewrite when the provider has no inline marker
 *  syntax: videos → "reference video N" (or "the source video" for a single
 *  source clip), images → "reference image N", audio → "reference audio N". */
export function replaceNaturalAssetMentions(
  prompt: string,
  refs: {
    sourceVideoRef?: string | null;
    imageRefs?: readonly string[];
    videoRefs?: readonly string[];
    audioRefs?: readonly string[];
  },
): string {
  let out = prompt;
  if (refs.sourceVideoRef) {
    out = replaceHappyHorseAssetMentions(out, refs.sourceVideoRef, [], []);
  }
  const multiVideos = refs.videoRefs ?? [];
  out = replaceNotebookMentions(
    out,
    refMentionEntries(multiVideos).map(({ ref, index }) => ({
      reference: ref,
      replacement: multiVideos.length === 1
        ? "the source video"
        : `reference video ${index + 1}`,
    })),
  );
  out = replaceHappyHorseAssetMentions(out, null, refs.imageRefs ?? [], refs.audioRefs ?? []);
  return out;
}
