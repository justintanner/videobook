import { z } from "zod";
import type { NotebookDocument } from "videobook-engine";
import { resolveNotebookCellArtifactId } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { replaceNotebookMentions } from "videobook-engine/notebook-mentions";
import { getApiKey } from "./api-key.js";
import {
  grownShortSegments, isLegacyShortDraft, shortStoryboardOf, SHORT_STORYBOARD_MODEL_TITLES, SHORT_STORYBOARD_MODELS, SHORT_WORD_CEILINGS,
  type GoalShortDraft, type GoalShortPlan, type ShortAspectRatio,
} from "./goal-short-plan.js";
import type { GoalGenerationStage } from "./goal-store.js";
import { SHORT_AVOID, SHORT_BANNED_WORDS, SHORT_RULES, shortBannedWords, shortMentionsPhone } from "./goal-short-rules.js";
import { loadGuide } from "./tools/rewrite-prompt.js";

const LABELLED = /(?<![\p{L}\p{N}])(frame|video|beat\s*(\d+))\s*:\s*["“]([^"”]*)["”]/giu;
const CAMERA_LINE = "Call it the camera, never the phone: someone off screen holds it.";
const POSITIVE_LINE = 'Say what is there rather than what is not, such as "both hands hang empty at the sides" rather than "no phone in hand": the models tend to show any object a prompt names, even after "no" or "not".';
const QUOTED = /["“]([^"”]*)["”]/gu;
const PROMPT_LIMIT = 2000;
const PLANNED_FROM_BRIEF = "Planned from the brief as written. Add OPENAI_API_KEY in Settings for a written plan.";
const FOLLOW_FEEDBACK = "Change only what the feedback asks for and keep every other detail, in the same words where you can.";
const DROP_CONTRADICTED = "Remove or rewrite every sentence the feedback contradicts, so the prompt no longer says anything the feedback rules out. Never keep the old sentence and add the feedback beside it.";
const OVERLAYS = "captions, titles, stickers, emoji, logos, usernames, icons, borders, bars or shade";

export type ShortAuthoredCopy = {
  frame: string | null;
  beats: (string | null)[];
  segmentSeconds: number[];
  note: string | null;
};

type ShortBriefPlan = { frame: string; beats: string[]; note: string | null };

export type ShortPlannerResponse = { title: string; frame: string; beats: string[] };

export type ShortPlannerIssue = { kind: "count" | "empty" | "ceiling" | "banned" | "phone"; message: string };

export type ShortRevisionPart = { name: string; ceiling: number };

function briefProse(brief: string): string {
  return brief.replace(LABELLED, " ").replace(QUOTED, " ").replace(/@[\p{L}\p{N}-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function foldedBeatsNote(numbers: readonly number[]): string {
  const labels = numbers.map((number) => `beat ${number}`);
  if (labels.length === 1) return `The brief quotes ${labels[0]}, so that line is part of the last beat.`;
  const last = labels[labels.length - 1];
  return `The brief quotes ${labels.slice(0, -1).join(", ")} and ${last}, so those lines are part of the last beat.`;
}

export function shortAuthoredCopy(brief: string, segmentSeconds: readonly number[]): ShortAuthoredCopy {
  let frame: string | null = null;
  let video: string | null = null;
  const quoted = new Map<number, string>();
  for (const match of brief.matchAll(LABELLED)) {
    const text = match[3]!.trim();
    if (!text) continue;
    const label = match[1]!.toLowerCase();
    if (label === "frame") frame ??= text;
    else if (label === "video") video ??= text;
    else {
      const number = Number(match[2]);
      if (number >= 1 && !quoted.has(number)) quoted.set(number, text);
    }
  }
  let highest = 0;
  for (const number of quoted.keys()) {
    if (number > highest) highest = number;
  }
  const grown = highest > segmentSeconds.length ? grownShortSegments(segmentSeconds, highest) : null;
  const seconds = grown ?? [...segmentSeconds];
  const beats: (string | null)[] = Array.from({ length: seconds.length }, () => null);
  const folded: Array<{ number: number; text: string }> = [];
  for (const [number, text] of quoted) {
    const index = number - 1;
    if (index < beats.length) beats[index] ??= text;
    else folded.push({ number, text });
  }
  const unlabelled = [...brief.replace(LABELLED, " ").matchAll(QUOTED)].map((match) => match[1]!.trim()).filter(Boolean);
  beats[0] ??= video ?? (unlabelled.length === 1 ? unlabelled[0]! : null);
  let note: string | null = null;
  if (grown) note = `The brief quotes beat ${highest}, so this short has ${highest} segments.`;
  if (folded.length > 0) {
    folded.sort((left, right) => left.number - right.number);
    const last = beats.length - 1;
    const parts = [beats[last], ...folded.map((entry) => entry.text)].filter((part): part is string => part !== null && part !== "");
    beats[last] = parts.join(" ");
    note = foldedBeatsNote(folded.map((entry) => entry.number));
  }
  return { frame, beats, segmentSeconds: seconds, note };
}

export function shortPlannerNeeded(brief: string, segmentSeconds: readonly number[]): boolean {
  const authored = shortAuthoredCopy(brief, segmentSeconds);
  const needed = authored.frame === null || authored.beats.some((beat) => beat === null);
  return needed && getApiKey("OPENAI_API_KEY") !== null;
}

export function shortBriefPlan(brief: string, authored: ShortAuthoredCopy): ShortBriefPlan {
  const gaps = authored.frame === null || authored.beats.some((beat) => beat === null);
  const prose = briefProse(brief).slice(0, PROMPT_LIMIT).trim();
  const quoted = authored.frame ?? authored.beats.find((beat): beat is string => beat !== null);
  const filler = prose || quoted || "Short";
  return {
    frame: authored.frame ?? filler,
    beats: authored.beats.map((beat) => beat ?? filler),
    note: gaps ? PLANNED_FROM_BRIEF : null,
  };
}

export function shortTitle(brief: string, framePrompt: string): string {
  const title = (briefProse(brief) || framePrompt).split(/\s+/u).filter(Boolean).slice(0, SHORT_WORD_CEILINGS.title).join(" ").slice(0, 120).trim();
  return title || "Short";
}

type BriefReference = { artifactId: string; address?: string | null };

export function shortBriefNames(content: { draft: GoalShortDraft | null }, plan: GoalShortPlan) {
  const { draft } = content;
  if (draft) {
    return isLegacyShortDraft(draft)
      ? { references: [...draft.character.references, ...draft.extraReferences], storyboard: null }
      : { references: draft.sourceImages, storyboard: draft.storyboard?.video ?? null };
  }
  return plan.version === 5
    ? { references: plan.sourceImages, storyboard: plan.storyboard?.video ?? null }
    : { references: [...plan.character.references, ...plan.frame.references], storyboard: null };
}

export function shortPlannerBrief(
  brief: string,
  references: readonly BriefReference[],
  document: NotebookDocument | null,
  storyboardVideo: BriefReference | null = null,
): string {
  const named = (reference: BriefReference, replacement: string) => {
    const addresses = reference.address !== undefined
      ? [reference.address].filter((address): address is string => Boolean(address))
      : document
        ? document.cells.filter((cell) => resolveNotebookCellArtifactId(document, cell) === reference.artifactId).map((cell) => notebookGridTag(cell.slot))
        : [];
    return [{ reference: reference.artifactId, replacement }, ...addresses.map((address) => ({ reference: address, replacement }))];
  };
  return replaceNotebookMentions(brief, [
    ...references.flatMap((reference, index) => named(reference, `Source image ${index + 1}`)),
    ...(storyboardVideo ? named(storyboardVideo, "the storyboard") : []),
  ]);
}

export function shortPlannerResponseSchema(segmentCount: number) {
  return z.object({
    title: z.string().describe(`At most ${SHORT_WORD_CEILINGS.title} words`),
    frame: z.string().describe(`The opening frame, at most ${SHORT_WORD_CEILINGS.frame} words`),
    beats: z.array(z.string().describe(`One beat, at most ${SHORT_WORD_CEILINGS.beat} words`)).min(segmentCount).max(segmentCount)
      .describe("One beat per segment, in order"),
  }).strict();
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function partIssues(part: ShortRevisionPart, text: string, phones: boolean, empty = `Write the ${part.name}.`): ShortPlannerIssue[] {
  const issues: ShortPlannerIssue[] = [];
  const words = wordCount(text);
  if (words === 0) issues.push({ kind: "empty", message: empty });
  if (words > part.ceiling) issues.push({ kind: "ceiling", message: `Shorten the ${part.name} to at most ${part.ceiling} words; it has ${words}.` });
  const banned = shortBannedWords(text);
  if (banned.length > 0) issues.push({ kind: "banned", message: `Remove ${banned.map((word) => `"${word}"`).join(", ")} from the ${part.name}.` });
  if (!phones && shortMentionsPhone(text)) issues.push({ kind: "phone", message: `Leave the phone out of the ${part.name}: call it the camera, which someone off screen holds.` });
  return issues;
}

export function shortPlannerIssues(response: ShortPlannerResponse, segmentCount: number, authored?: ShortAuthoredCopy, phones = true): ShortPlannerIssue[] {
  const issues: ShortPlannerIssue[] = [];
  if (response.beats.length !== segmentCount) {
    issues.push({ kind: "count", message: `Write exactly ${segmentCount} beats, one per segment, not ${response.beats.length}.` });
  }
  const parts = [
    { name: "title", text: response.title, ceiling: SHORT_WORD_CEILINGS.title, fixed: false, prompt: false },
    { name: "frame", text: response.frame, ceiling: SHORT_WORD_CEILINGS.frame, fixed: authored?.frame != null, prompt: true },
    ...response.beats.map((text, index) => ({ name: `beat ${index + 1}`, text, ceiling: SHORT_WORD_CEILINGS.beat, fixed: authored?.beats[index] != null, prompt: true })),
  ];
  for (const part of parts.filter((candidate) => !candidate.fixed)) issues.push(...partIssues(part, part.text, phones || !part.prompt));
  return issues;
}

export function shortRevisionPart(plan: GoalShortPlan, stage: GoalGenerationStage, index: number): ShortRevisionPart & { prompt: string } {
  if (stage === "storyboards") {
    const storyboard = shortStoryboardOf(plan);
    const frame = storyboard?.frames[index];
    if (!frame) throw new RangeError(storyboard ? `The storyboard has ${storyboard.frames.length} frames.` : "This short has no storyboard.");
    return { name: `storyboard frame ${index + 1} clean-up`, ceiling: SHORT_WORD_CEILINGS.cleanup, prompt: frame.prompt };
  }
  if (stage === "frame") return { name: "frame", ceiling: SHORT_WORD_CEILINGS.frame, prompt: plan.frame.prompt };
  const segment = plan.segments[index];
  if (!segment) throw new RangeError(`This short has ${plan.segments.length} segments.`);
  return { name: `beat ${index + 1}`, ceiling: SHORT_WORD_CEILINGS.beat, prompt: segment.prompt };
}

export function shortRevisionIssues(prompt: string, part: ShortRevisionPart, phones: boolean): ShortPlannerIssue[] {
  return partIssues(part, prompt, phones, `Write the whole revised ${part.name}.`);
}

export function shortRevisionResponseSchema(part: ShortRevisionPart) {
  return z.object({
    prompt: z.string().describe(`The whole revised ${part.name}, at most ${part.ceiling} words`),
  }).strict();
}

function shortStar(sourceImageCount: number): string {
  return sourceImageCount > 0 ? "the person in the source images" : "the person the brief describes";
}

function plannerImageLines(sourceImageCount: number, storyboardFrameCount: number): string[] {
  if (storyboardFrameCount === 0) {
    return ["The images are source images, labelled Source image 1, Source image 2 in order, and the brief names them the same way. Describe what they show in plain words instead of naming or numbering them, and write no @tokens."];
  }
  const frames = storyboardFrameCount === 1
    ? "the storyboard frame, labelled Storyboard frame 1 of 1 with its time in the video"
    : `the ${storyboardFrameCount} storyboard frames, labelled Storyboard frame 1 of ${storyboardFrameCount} and so on, each with its time in the video`;
  const order = sourceImageCount > 0
    ? `The images come in order: first the source images, labelled Source image 1, Source image 2 and so on, which the brief names the same way, then ${frames}.`
    : `The images are ${frames}.`;
  return [
    `${order} The storyboard frames come from the video the brief calls the storyboard. Describe what the images show in plain words instead of naming or numbering them, and write no @tokens.`,
    "Follow the storyboard's action, camera and order across the opening frame and the beats, and apply the brief's changes to it: the people come from the source images or the brief, and anything the brief swaps in, such as a different animal, replaces what the storyboard shows.",
    `Never describe anything drawn on top of the picture in the storyboard frames, such as ${OVERLAYS}: those are removed before the frame is made.`,
  ];
}

export async function shortPlannerInstructions(input: {
  sourceImageCount: number;
  storyboardFrameCount?: number;
  aspectRatio: ShortAspectRatio;
  segmentSeconds: readonly number[];
}): Promise<string> {
  const [h3Guide, imageGuide] = await Promise.all([loadGuide("minimax_h3"), loadGuide("gpt_image_26")]);
  const count = input.segmentSeconds.length;
  return [
    `Plan a short that looks like real phone footage filmed by someone off screen, starring ${shortStar(input.sourceImageCount)}. That person never speaks.`,
    `Return JSON with a title, one opening frame prompt for GPT Image 2.6 and ${count === 1 ? "one beat" : `${count} beats`} for MiniMax H3 Max, one per segment: ${input.segmentSeconds.map((seconds, index) => `beat ${index + 1} lasts ${seconds} seconds`).join(", ")}. The aspect ratio is ${input.aspectRatio}.`,
    `Word ceilings, not targets: title ${SHORT_WORD_CEILINGS.title}, frame ${SHORT_WORD_CEILINGS.frame}, each beat ${SHORT_WORD_CEILINGS.beat}.`,
    "Beat 1 starts from the opening frame. Each later beat continues from where the previous one ends, in the same place, and every beat ends with that person in frame. One action per beat, in the present tense, with what the camera does and what is heard.",
    CAMERA_LINE,
    `${POSITIVE_LINE} Give that person a phone only when the brief does.`,
    ...plannerImageLines(input.sourceImageCount, input.storyboardFrameCount ?? 0),
    "Write only the parts listed under write and keep the fixed parts exactly as given.",
    "These lines are added to the prompts after you write them. Do not repeat them and do not contradict them:",
    `Frame: ${SHORT_RULES.frame}`,
    `Video: ${SHORT_RULES.video}`,
    `Silence: ${SHORT_RULES.silence}`,
    `Avoid: ${SHORT_AVOID.join("; ")}.`,
    `Never use these words: ${SHORT_BANNED_WORDS.join(", ")}.`,
    `--- MiniMax H3 prompting guide ---\n${h3Guide.trim()}`,
    `--- GPT Image 2.6 prompting guide ---\n${imageGuide.trim()}`,
  ].join("\n");
}

function storyboardRevisionInstructions(plan: GoalShortPlan, index: number): string {
  const part = shortRevisionPart(plan, "storyboards", index);
  const storyboard = shortStoryboardOf(plan);
  const count = storyboard?.frames.length ?? 1;
  const model = SHORT_STORYBOARD_MODEL_TITLES[storyboard?.model ?? SHORT_STORYBOARD_MODELS[0]];
  return [
    `Revise the clean-up prompt for storyboard frame ${index + 1} of ${count}, one frame of a video. ${model} edit follows it to remove the on-screen graphics added on top of the camera picture, such as ${OVERLAYS}, and to fill those areas with what the camera saw.`,
    "Rewrite it so it follows the operator's feedback.",
    FOLLOW_FEEDBACK,
    DROP_CONTRADICTED,
    "It edits this one frame: everything the feedback does not name stays as the camera saw it, including the people, animals, objects, place, light, framing and size, and printing that is physically on things.",
    `Write at most ${part.ceiling} words, and answer with the whole revised ${part.name}.`,
  ].join("\n");
}

export async function shortRevisionInstructions(plan: GoalShortPlan, stage: GoalGenerationStage, index: number): Promise<string> {
  if (stage === "storyboards") return storyboardRevisionInstructions(plan, index);
  const frame = stage === "frame";
  const part = shortRevisionPart(plan, stage, index);
  const guide = await loadGuide(frame ? "gpt_image_26" : "minimax_h3");
  const images = plan.version === 5 ? plan.sourceImages.length : plan.character.references.length;
  return [
    `Revise one prompt of a short that looks like real phone footage filmed by someone off screen, starring ${shortStar(images)}. That person never speaks.`,
    frame
      ? "Rewrite the opening frame prompt for GPT Image 2.6 so it follows the operator's feedback. It describes the one still picture the short opens on."
      : `Rewrite beat ${index + 1} of ${plan.segments.length} for MiniMax H3 Max, which lasts ${plan.segments[index]!.seconds} seconds, so it follows the operator's feedback. One action in the present tense, with what the camera does and what is heard. ${index === 0 ? "It starts from the opening frame" : "It continues from where the beat before it ends, in the same place,"} and ends with that person in frame.`,
    FOLLOW_FEEDBACK,
    DROP_CONTRADICTED,
    CAMERA_LINE,
    `${POSITIVE_LINE} Give that person a phone only when the feedback or the brief does.`,
    `Write at most ${part.ceiling} words, and answer with the whole revised ${part.name}.`,
    "These lines are added to the prompt after you write it. Do not repeat them and do not contradict them:",
    ...(frame ? [`Frame: ${plan.rules.frame}`] : [`Video: ${plan.rules.video}`, `Silence: ${plan.rules.silence}`]),
    `Avoid: ${SHORT_AVOID.join("; ")}.`,
    `Never use these words: ${SHORT_BANNED_WORDS.join(", ")}.`,
    `--- ${frame ? "GPT Image 2.6" : "MiniMax H3"} prompting guide ---\n${guide.trim()}`,
  ].join("\n");
}
