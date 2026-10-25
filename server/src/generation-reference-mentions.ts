import {
  normalizeNotebookReference,
  replaceNotebookMentions,
  stripNotebookMentions,
} from "videobook-engine/notebook-mentions";

function refMentionEntries(refs: readonly string[]): { ref: string; index: number }[] {
  return refs
    .map((raw, index) => ({
      ref: normalizeNotebookReference(raw),
      index,
    }))
    .filter((e) => e.ref !== "")
    .sort((a, b) => b.ref.length - a.ref.length);
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

function numberedMentions(refs: readonly string[], marker: string): Array<{ reference: string; replacement: string }> {
  return refMentionEntries(refs).map(({ ref, index }) => ({
    reference: ref,
    replacement: `@${marker}_${index + 1}`,
  }));
}

export function rewriteKling4ReferenceMentions(
  prompt: string,
  imageRefs: readonly string[],
  videoRefs: readonly string[],
): string {
  return replaceNotebookMentions(prompt, [
    ...numberedMentions(imageRefs, "image"),
    ...numberedMentions(videoRefs, "video"),
  ]);
}

export function rewriteKling4FrameMentions(
  prompt: string,
  frames: { first: readonly string[]; keyframes: readonly string[]; last: readonly string[] },
): string {
  return replaceNotebookMentions(prompt, [
    ...frames.first.slice(0, 1).map((reference) => ({ reference, replacement: "@first_frame" })),
    ...numberedMentions(frames.keyframes, "keyframe"),
    ...frames.last.slice(0, 1).map((reference) => ({ reference, replacement: "@last_frame" })),
  ]);
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
