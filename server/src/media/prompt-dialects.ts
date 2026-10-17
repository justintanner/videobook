import {
  replaceHappyHorseAssetMentions,
  replaceNaturalAssetMentions,
  rewriteImageRefMentions,
  rewriteImageRefMentionsToBrackets,
  rewriteSeedanceAssetMentions,
  rewriteViduReferenceMentions,
  stripRefMentions,
} from "../google-flow-refs.js";
import type { MediaRefs, PromptDialect, RefRole } from "./types.js";

const SLOT_TOKEN = /@((image|video|audio)(\d+)|firstframe|lastframe)(?![\w-])/giu;

function refsFor(refs: MediaRefs, role: RefRole): string[] {
  return (refs[role] ?? []).filter((ref) => !/^https?:\/\//u.test(ref));
}

function slotTarget(refs: MediaRefs, token: string, kind: string | undefined, index: string | undefined): string | undefined {
  if (token.toLowerCase() === "firstframe") return refsFor(refs, "first_frame")[0];
  if (token.toLowerCase() === "lastframe") return refsFor(refs, "last_frame")[0];
  return refsFor(refs, kind!.toLowerCase() as RefRole)[Number(index) - 1];
}

export function expandSlotTokens(prompt: string, refs: MediaRefs): string {
  return prompt.replace(SLOT_TOKEN, (match, token: string, kind?: string, index?: string) => {
    const target = slotTarget(refs, token, kind, index);
    return target ? `@${target}` : match;
  });
}

function frames(refs: MediaRefs): string[] {
  return [...refsFor(refs, "first_frame"), ...refsFor(refs, "last_frame")];
}

function natural(prompt: string, refs: MediaRefs): string {
  return replaceNaturalAssetMentions(prompt, {
    imageRefs: refsFor(refs, "image"),
    videoRefs: refsFor(refs, "video"),
    audioRefs: refsFor(refs, "audio"),
  });
}

function seedance(prompt: string, refs: MediaRefs): string {
  return rewriteSeedanceAssetMentions(prompt, {
    imageRefs: refsFor(refs, "image"),
    videoRefs: refsFor(refs, "video"),
    audioRefs: refsFor(refs, "audio"),
  });
}

function rewrite(dialect: PromptDialect, prompt: string, refs: MediaRefs): string {
  switch (dialect) {
    case "plain":
      return prompt;
    case "natural":
      return natural(prompt, refs);
    case "natural_numbered":
      return natural(prompt, refs).replace(/@image([1-9]\d*)\b/giu, "reference image $1");
    case "natural_kinds":
      return natural(prompt, refs).replace(/@(image|audio)([1-9]\d*)(?![\w-])/giu,
        (_match, kind: string, index: string) => `reference ${kind.toLowerCase()} ${index}`);
    case "natural_source_video":
      return replaceNaturalAssetMentions(prompt, {
        imageRefs: refsFor(refs, "image"),
        sourceVideoRef: refsFor(refs, "video")[0] ?? null,
      });
    case "seedance":
      return stripRefMentions(seedance(prompt, refs), frames(refs));
    case "image_ref":
      return stripRefMentions(
        rewriteImageRefMentions(prompt, refsFor(refs, "image")),
        [...frames(refs), ...refsFor(refs, "video")],
      );
    case "image_ref_reference":
      return rewriteImageRefMentions(prompt, refsFor(refs, "image"), "reference");
    case "strip_frames":
      return stripRefMentions(prompt, [...frames(refs), ...refsFor(refs, "image")]);
    case "brackets":
      return rewriteImageRefMentionsToBrackets(prompt, refsFor(refs, "image"));
    case "vidu":
      return rewriteViduReferenceMentions(prompt, refsFor(refs, "image"), refsFor(refs, "audio"));
    case "happyhorse_edit":
      return replaceHappyHorseAssetMentions(prompt, refsFor(refs, "video")[0] ?? null, refsFor(refs, "image"));
  }
}

export function applyPromptDialect(dialect: PromptDialect | undefined, prompt: string, refs: MediaRefs): string {
  return rewrite(dialect ?? "natural", expandSlotTokens(prompt, refs), refs).replace(/[ \t]{2,}/gu, " ").trim();
}
