import { z } from "zod";
import type { NotebookDocument } from "videobook-engine";
import { resolveNotebookCellArtifactId } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { replaceNotebookMentions } from "videobook-engine/notebook-mentions";
import { getApiKey } from "./api-key.js";
import { grownShortSegments, SHORT_WORD_CEILINGS, type GoalShortPlan, type ShortAspectRatio } from "./goal-short-plan.js";
import { SHORT_AVOID, SHORT_BANNED_WORDS, SHORT_RULES, shortBannedWords, shortMentionsPhone } from "./goal-short-rules.js";
import { loadGuide } from "./tools/rewrite-prompt.js";

const LABELLED = /(?<![\p{L}\p{N}])(frame|video|beat\s*(\d+))\s*:\s*["“]([^"”]*)["”]/giu;
const CAMERA_LINE = "Call it the camera, never the phone: someone off screen holds it.";
const POSITIVE_LINE = 'Say what is there rather than what is not, such as "both hands hang empty at the sides" rather than "no phone in hand": the models tend to show any object a prompt names, even after "no" or "not".';
const QUOTED = /["“]([^"”]*)["”]/gu;
const PROMPT_LIMIT = 2000;
const PLANNED_FROM_BRIEF = "Planned from the brief as written. Add OPENAI_API_KEY in Settings for a written plan.";

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

export function shortPlannerBrief(brief: string, references: readonly { artifactId: string }[], document: NotebookDocument): string {
  return replaceNotebookMentions(brief, references.flatMap((reference, index) => {
    const replacement = `Source image ${index + 1}`;
    const cells = document.cells.filter((cell) => resolveNotebookCellArtifactId(document, cell) === reference.artifactId);
    return [{ reference: reference.artifactId, replacement }, ...cells.map((cell) => ({ reference: notebookGridTag(cell.slot), replacement }))];
  }));
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

export function shortRevisionPart(plan: GoalShortPlan, stage: "frame" | "videos", index: number): ShortRevisionPart & { prompt: string } {
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

export async function shortPlannerInstructions(input: {
  sourceImageCount: number;
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
    "The images are source images, labelled Source image 1, Source image 2 in order, and the brief names them the same way. Describe what they show in plain words instead of naming or numbering them, and write no @tokens.",
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

export async function shortRevisionInstructions(plan: GoalShortPlan, stage: "frame" | "videos", index: number): Promise<string> {
  const frame = stage === "frame";
  const part = shortRevisionPart(plan, stage, index);
  const guide = await loadGuide(frame ? "gpt_image_26" : "minimax_h3");
  const images = plan.version === 5 ? plan.sourceImages.length : plan.character.references.length;
  return [
    `Revise one prompt of a short that looks like real phone footage filmed by someone off screen, starring ${shortStar(images)}. That person never speaks.`,
    frame
      ? "Rewrite the opening frame prompt for GPT Image 2.6 so it follows the operator's feedback. It describes the one still picture the short opens on."
      : `Rewrite beat ${index + 1} of ${plan.segments.length} for MiniMax H3 Max, which lasts ${plan.segments[index]!.seconds} seconds, so it follows the operator's feedback. One action in the present tense, with what the camera does and what is heard. ${index === 0 ? "It starts from the opening frame" : "It continues from where the beat before it ends, in the same place,"} and ends with that person in frame.`,
    "Change only what the feedback asks for and keep every other detail, in the same words where you can.",
    "Remove or rewrite every sentence the feedback contradicts, so the prompt no longer says anything the feedback rules out. Never keep the old sentence and add the feedback beside it.",
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
