import {
  replaceHappyHorseAssetMentions,
  replaceNaturalAssetMentions,
  rewriteGeminiOmniReferenceMentions,
  rewriteGrokReferenceMentions,
  rewriteImageRefMentionsToBrackets,
  rewriteKling4FrameMentions,
  rewriteKling4ReferenceMentions,
  rewriteKlingOmniReferenceMentions,
  rewriteSeedanceAssetMentions,
  rewriteViduReferenceMentions,
  stripRefMentions,
} from "../generation-reference-mentions.js";
import { generationInputTokenPattern } from "../generation-input-targets.js";
import { normalizeNotebookReference, replaceNotebookMentions } from "videobook-engine/notebook-mentions";
import type { MediaRefs, PromptDialect, RefRole } from "./types.js";

const ROLE_PHRASES: ReadonlyArray<readonly [RefRole, (index: number, count: number) => string]> = [
  ["first_frame", () => "the first frame"],
  ["last_frame", () => "the last frame"],
  ["loop", () => "the loop frame"],
  ["keyframe", (index) => `keyframe ${index + 1}`],
  ["image", (index) => `reference image ${index + 1}`],
  ["video", (index, count) => count === 1 ? "the source video" : `reference video ${index + 1}`],
  ["audio", (index) => `reference audio ${index + 1}`],
];

function refsFor(refs: MediaRefs, role: RefRole): string[] {
  return (refs[role] ?? []).filter((ref) => !/^https?:\/\//u.test(ref));
}

function slotTarget(refs: MediaRefs, token: string, kind: string | undefined, index: string | undefined): string | undefined {
  if (token.toLowerCase() === "firstframe") return refsFor(refs, "first_frame")[0];
  if (token.toLowerCase() === "lastframe") return refsFor(refs, "last_frame")[0];
  if (token.toLowerCase() === "loop") return refsFor(refs, "loop")[0];
  return refsFor(refs, kind!.toLowerCase() as RefRole)[Number(index) - 1];
}

function expandSlotTokens(prompt: string, refs: MediaRefs): string {
  return prompt.replace(generationInputTokenPattern(), (match, token: string, kind?: string, index?: string) => {
    const target = slotTarget(refs, token, kind, index);
    return target ? `@${target}` : match;
  });
}

function frames(refs: MediaRefs): string[] {
  return [...refsFor(refs, "first_frame"), ...refsFor(refs, "last_frame"), ...refsFor(refs, "loop"), ...refsFor(refs, "keyframe")];
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
    case "natural_strip_frames":
      return stripRefMentions(natural(prompt, refs), frames(refs));
    case "natural_source_video":
      return replaceNaturalAssetMentions(prompt, {
        imageRefs: refsFor(refs, "image"),
        sourceVideoRef: refsFor(refs, "video")[0] ?? null,
      });
    case "seedance":
      return stripRefMentions(seedance(prompt, refs), frames(refs));
    case "strip_frames":
      return stripRefMentions(prompt, [...frames(refs), ...refsFor(refs, "image")]);
    case "brackets":
      return rewriteImageRefMentionsToBrackets(prompt, refsFor(refs, "image"));
    case "vidu":
      return rewriteViduReferenceMentions(prompt, refsFor(refs, "image"), refsFor(refs, "audio"));
    case "kling4":
      return rewriteKling4ReferenceMentions(prompt, refsFor(refs, "image"), refsFor(refs, "video"));
    case "kling4_keyframes":
      return rewriteKling4FrameMentions(prompt, {
        first: refsFor(refs, "first_frame"),
        keyframes: refsFor(refs, "image"),
        last: refsFor(refs, "last_frame"),
      });
    case "kling_omni":
      return rewriteKlingOmniReferenceMentions(prompt, refsFor(refs, "image"), refsFor(refs, "video"));
    case "gemini_omni":
      return rewriteGeminiOmniReferenceMentions(prompt, refsFor(refs, "image"), refsFor(refs, "video"));
    case "grok":
      return rewriteGrokReferenceMentions(prompt, refsFor(refs, "image"));
    case "happyhorse_edit":
      return replaceHappyHorseAssetMentions(prompt, refsFor(refs, "video")[0] ?? null, refsFor(refs, "image"));
  }
}

function renderRefMentions(prompt: string, refs: MediaRefs): string {
  const replacements = ROLE_PHRASES.flatMap(([role, phrase]) => {
    const list = refsFor(refs, role);
    return list.map((ref, index) => ({ reference: normalizeNotebookReference(ref), replacement: phrase(index, list.length) }));
  }).filter((entry) => entry.reference !== "").sort((left, right) => right.reference.length - left.reference.length);
  return replaceNotebookMentions(prompt, replacements);
}

export function applyPromptDialect(
  dialect: PromptDialect | undefined,
  prompt: string,
  refs: MediaRefs,
  unmentioned: readonly string[] = [],
): string {
  const rewritten = rewrite(dialect ?? "natural", expandSlotTokens(prompt, refs), refs);
  const rendered = renderRefMentions(rewritten, refs);
  return (unmentioned.length > 0 ? stripRefMentions(rendered, unmentioned) : rendered).replace(/[ \t]{2,}/gu, " ").trim();
}
