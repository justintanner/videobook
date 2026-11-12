import { z } from "zod";
import type { NotebookDocument } from "videobook-engine";
import { resolveNotebookCellArtifactId } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { replaceNotebookMentions } from "videobook-engine/notebook-mentions";
import { SHORT_WORD_CEILINGS, type ShortAspectRatio } from "./goal-short-plan.js";
import { SHORT_AVOID, SHORT_BANNED_WORDS, SHORT_RULES, shortBannedWords } from "./goal-short-rules.js";
import { loadGuide } from "./tools/rewrite-prompt.js";

const LABELLED = /(?<![\p{L}\p{N}])(frame|video|beat\s*(\d+))\s*:\s*["“]([^"”]*)["”]/giu;
const QUOTED = /["“]([^"”]*)["”]/gu;

export type ShortAuthoredCopy = { frame: string | null; beats: (string | null)[] };

export type ShortPlannerResponse = { title: string; frame: string; beats: string[] };

export type ShortPlannerIssue = { kind: "count" | "empty" | "ceiling" | "banned"; message: string };

function segments(count: number): string {
  return `${count} ${count === 1 ? "segment" : "segments"}`;
}

export function shortAuthoredCopy(brief: string, segmentCount: number): ShortAuthoredCopy {
  let frame: string | null = null;
  let video: string | null = null;
  const beats: (string | null)[] = Array.from({ length: segmentCount }, () => null);
  for (const match of brief.matchAll(LABELLED)) {
    const text = match[3]!.trim();
    if (!text) continue;
    const label = match[1]!.toLowerCase();
    if (label === "frame") frame ??= text;
    else if (label === "video") video ??= text;
    else {
      const index = Number(match[2]) - 1;
      if (index < 0 || index >= segmentCount) {
        throw new Error(`The brief quotes beat ${index + 1}, but this short has ${segments(segmentCount)}.`);
      }
      beats[index] ??= text;
    }
  }
  const unlabelled = [...brief.replace(LABELLED, " ").matchAll(QUOTED)].map((match) => match[1]!.trim()).filter(Boolean);
  beats[0] ??= video ?? (unlabelled.length === 1 ? unlabelled[0]! : null);
  return { frame, beats };
}

export function shortPlannerNeeded(brief: string, segmentCount: number): boolean {
  const authored = shortAuthoredCopy(brief, segmentCount);
  const needed = authored.frame === null || authored.beats.some((beat) => beat === null);
  if (needed && !process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY in Settings, or quote the frame and beat prompts.");
  return needed;
}

export function shortTitle(brief: string, framePrompt: string): string {
  const prose = brief.replace(LABELLED, " ").replace(QUOTED, " ").replace(/@[\p{L}\p{N}-]+/gu, " ").replace(/\s+/gu, " ").trim();
  const title = (prose || framePrompt).split(/\s+/u).filter(Boolean).slice(0, SHORT_WORD_CEILINGS.title).join(" ").slice(0, 120).trim();
  return title || "Short";
}

export function shortPlannerBrief(brief: string, references: readonly { artifactId: string }[], document: NotebookDocument): string {
  return replaceNotebookMentions(brief, references.flatMap((reference, index) => {
    const replacement = `Reference ${index + 1}`;
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

export function shortPlannerIssues(response: ShortPlannerResponse, segmentCount: number, authored?: ShortAuthoredCopy): ShortPlannerIssue[] {
  const issues: ShortPlannerIssue[] = [];
  if (response.beats.length !== segmentCount) {
    issues.push({ kind: "count", message: `Write exactly ${segmentCount} beats, one per segment, not ${response.beats.length}.` });
  }
  const parts = [
    { name: "title", text: response.title, ceiling: SHORT_WORD_CEILINGS.title, fixed: false },
    { name: "frame", text: response.frame, ceiling: SHORT_WORD_CEILINGS.frame, fixed: authored?.frame != null },
    ...response.beats.map((text, index) => ({ name: `beat ${index + 1}`, text, ceiling: SHORT_WORD_CEILINGS.beat, fixed: authored?.beats[index] != null })),
  ];
  for (const part of parts.filter((candidate) => !candidate.fixed)) {
    const words = wordCount(part.text);
    if (words === 0) issues.push({ kind: "empty", message: `Write the ${part.name}.` });
    if (words > part.ceiling) issues.push({ kind: "ceiling", message: `Shorten the ${part.name} to at most ${part.ceiling} words; it has ${words}.` });
    const banned = shortBannedWords(part.text);
    if (banned.length > 0) issues.push({ kind: "banned", message: `Remove ${banned.map((word) => `"${word}"`).join(", ")} from the ${part.name}.` });
  }
  return issues;
}

export async function shortPlannerInstructions(input: {
  character: { name: string; description: string };
  aspectRatio: ShortAspectRatio;
  segmentSeconds: readonly number[];
}): Promise<string> {
  const [h3Guide, imageGuide] = await Promise.all([loadGuide("minimax_h3"), loadGuide("gpt_image_26")]);
  const count = input.segmentSeconds.length;
  return [
    `Plan a short of real phone footage starring ${input.character.name}: ${input.character.description}. The main character never speaks.`,
    `Return JSON with a title, one opening frame prompt for GPT Image 2.6 and ${count === 1 ? "one beat" : `${count} beats`} for MiniMax H3 Max, one per segment: ${input.segmentSeconds.map((seconds, index) => `beat ${index + 1} lasts ${seconds} seconds`).join(", ")}. The aspect ratio is ${input.aspectRatio}.`,
    `Word ceilings, not targets: title ${SHORT_WORD_CEILINGS.title}, frame ${SHORT_WORD_CEILINGS.frame}, each beat ${SHORT_WORD_CEILINGS.beat}.`,
    "Beat 1 starts from the opening frame. Each later beat continues from where the previous one ends, in the same place, and every beat ends with the main character in frame. One action per beat, in the present tense, with what the camera does and what is heard.",
    "The images are references, labelled Reference 1, Reference 2 in order, and the brief names them the same way. Describe what they show in plain words instead of naming or numbering them, and write no @tokens.",
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
