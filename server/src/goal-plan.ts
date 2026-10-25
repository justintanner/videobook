import { z } from "zod";
import type { ChainStep } from "./chain-plan.js";
import type { GoalPlanV3 } from "./goal-plan-v3.js";
import { LIGHTNING_VIDEO_MODEL } from "./lightning-defaults.js";
import { GOAL_PROMPT_BUDGET, goalPromptWords } from "./goal-prompt-budget.js";
import { GOAL_STYLE_IDS, goalStyleFragment, resolveGoalStyleOptions, type GoalStyleStage } from "./goal-styles.js";

export type { GoalMediaRef, GoalPlanV3 } from "./goal-plan-v3.js";
export { compileGoalV3Approval, compileGoalV3Steps, goalMediaRefSchema, goalPlanV3Schema, isGoalPlanV3, refreshGoalPlanV3, savedGoalPlanV3Schema } from "./goal-plan-v3.js";

export { GOAL_PROMPT_BUDGET, goalPromptWords } from "./goal-prompt-budget.js";

export const GOAL_VIDEO_TOOL = "generate_video";
export const GOAL_VIDEO_MODEL = LIGHTNING_VIDEO_MODEL;
const GOAL_IMAGE_MODELS = {
  "nano-banana-2-1": { text: "kie:nano-banana-2-1", edit: "kie:nano-banana-2-1" },
  sunburst: { text: "kie:gpt-image-2-5-sunburst-text-to-image", edit: "kie:gpt-image-2-5-sunburst-image-to-image" },
  flare: { text: "kie:gpt-image-2-5-flare-text-to-image", edit: "kie:gpt-image-2-5-flare-image-to-image" },
} as const;
const GOAL_MAX_SHOTS = 8;
const goalPrompt = (limit: number) => z.string().trim().min(1).max(limit)
  .regex(/^[^@]*$/u, "Use Reference 1, Reference 2 and plain text in plan prompts; input references are added automatically");

export const goalStyleSchema = z.object({
  id: z.enum(GOAL_STYLE_IDS), options: z.record(z.string(), z.string()),
}).strict().superRefine((style, context) => {
  try { resolveGoalStyleOptions(style.id, style.options); }
  catch (error) { context.addIssue({ code: "custom", path: ["options"], message: error instanceof Error ? error.message : String(error), fatal: true }); }
}).overwrite(style => ({ ...style, options: resolveGoalStyleOptions(style.id, style.options) }));

export const legacyGoalPlanSchema = z.object({
  title: z.string().trim().min(1).max(120),
  continuity: z.string().trim().min(1).max(3000),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
  shots: z.array(z.object({
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(6000),
    durationSeconds: z.number().int().min(4).max(30),
  })).min(1).max(GOAL_MAX_SHOTS),
}).strict();

export const goalPlanSchema = legacyGoalPlanSchema.extend({
  version: z.literal(2),
  style: goalStyleSchema.default({ id: "cinematic", options: {} }),
  title: goalPrompt(120),
  continuity: goalPrompt(3000),
  imageModel: z.enum(["sunburst", "flare", "nano-banana-2-1"]).default("sunburst"),
  storyboardLayout: z.enum(["four-panel", "six-panel"]).optional(),
  referenceRoles: z.array(z.enum(["scene", "character", "prop", "reference"])).max(8).optional(),
  imageResolution: z.enum(["1K", "2K"]).default("2K"),
  videoResolution: z.enum(["480p", "720p"]).default("720p"),
  frameContinuity: z.boolean().default(false),
  frame: z.object({ prompt: goalPrompt(6000) }).strict(),
  shots: z.array(z.object({
    title: goalPrompt(120),
    storyboardPrompt: goalPrompt(6000),
    endingPrompt: goalPrompt(6000).nullable().default(null),
    videoPrompt: goalPrompt(6000),
    durationSeconds: z.number().int().min(4).max(30),
  }).strict()).min(1).max(GOAL_MAX_SHOTS),
}).strict();

export const goalPlannerResponseSchema = goalPlanSchema.extend({
  storyboardLayout: z.enum(["four-panel", "six-panel"]).default("six-panel"),
  referenceRoles: z.array(z.enum(["scene", "character", "prop", "reference"])).max(8).default([]),
  title: goalPrompt(80),
  continuity: goalPrompt(600),
  frame: z.object({ prompt: goalPrompt(400) }).strict(),
  shots: z.array(goalPlanSchema.shape.shots.element.extend({
    title: goalPrompt(80),
    storyboardPrompt: goalPrompt(500),
    endingPrompt: goalPrompt(250).nullable().default(null),
    videoPrompt: goalPrompt(400),
  })).min(1).max(GOAL_MAX_SHOTS),
});

export type GoalPlan = z.infer<typeof goalPlanSchema>;
export type LegacyGoalPlan = z.infer<typeof legacyGoalPlanSchema>;
export type GoalDisplayPlan = GoalPlan | LegacyGoalPlan | GoalPlanV3;
export type GoalStage = "frame" | "storyboards" | "videos" | "assembly";
export type GoalGenerationStage = Exclude<GoalStage, "assembly">;
export type GoalStillStage = Extract<GoalGenerationStage, "frame" | "storyboards">;
export type GoalCharacter = { artifactId: string; cellId: string; address: string; label: string };

export function goalPromptBudgetIssues(plan: GoalPlan): string[] {
  const fields: Array<[string, string, number]> = [
    ["Title", plan.title, GOAL_PROMPT_BUDGET.title],
    ["Continuity", plan.continuity, GOAL_PROMPT_BUDGET.continuity],
    ["Frame", plan.frame.prompt, GOAL_PROMPT_BUDGET.frame],
    ...plan.shots.flatMap((shot, index): Array<[string, string, number]> => [
      [`Shot ${index + 1} title`, shot.title, GOAL_PROMPT_BUDGET.title],
      [`Storyboard ${index + 1}`, shot.storyboardPrompt, plan.storyboardLayout === "six-panel" ? 48 : GOAL_PROMPT_BUDGET.storyboard],
      [`Ending ${index + 1}`, shot.endingPrompt ?? "", GOAL_PROMPT_BUDGET.ending],
      [`Video ${index + 1}`, shot.videoPrompt, GOAL_PROMPT_BUDGET.video],
    ]),
  ];
  return fields.flatMap(([label, value, limit]) => {
    const words = goalPromptWords(value);
    return words > limit ? [`${label}: ${words} words; limit ${limit}.`] : [];
  });
}

export function goalBriefConstraints(brief: string): {
  shotCount: number;
  durationSeconds: number;
  aspectRatio: GoalPlan["aspectRatio"];
} {
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12,
  };
  const modifiers = "(?:(?:short|funny|comedic|cinematic|animated|portrait|vertical|square|landscape|horizontal)[ -]+){0,3}";
  const count = new RegExp(`\\b(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\s+${modifiers}(?:\\d+(?:\\.\\d+)?[ -]*(?:s|secs?|seconds?)[ -]*)?${modifiers}(?:clips?|videos?)\\b`, "iu").exec(brief);
  const multiplier = /\b(\d+)\s*[x×]\s*(\d+)\s*(?:s|secs?|seconds?)\b/iu.exec(brief);
  const clipDuration = /\b(\d+(?:\.\d+)?)[ -]*(?:s|secs?|seconds?)[ -]*(?:clips?|shots?|scenes?|each)\b/iu.exec(brief)
    ?? /\b(?:clips?|shots?|scenes?)\s+(?:of\s+)?(\d+(?:\.\d+)?)[ -]*(?:s|secs?|seconds?)\b/iu.exec(brief);
  const duration = /\b(\d+(?:\.\d+)?)[ -]*(?:s|secs?|seconds?)\b/iu.exec(brief);
  const shotCount = count ? words[count[1]!.toLowerCase()] ?? Number(count[1])
    : multiplier ? Number(multiplier[1]) : 1;
  const durationSeconds = multiplier ? Number(multiplier[2]) : clipDuration ? Number(clipDuration[1]) : duration ? Number(duration[1]) : shotCount === 1 ? 20 : 10;
  if (!Number.isInteger(shotCount) || shotCount < 1 || shotCount > GOAL_MAX_SHOTS) {
    throw new Error(`A goal supports 1–${GOAL_MAX_SHOTS} clips. Choose a smaller shot count.`);
  }
  if (!Number.isInteger(durationSeconds) || durationSeconds < 4 || durationSeconds > 30) {
    throw new Error("Each goal clip must be a whole number of seconds from 4 to 30.");
  }
  const aspectRatio = /\b(?:16:9|landscape|horizontal|widescreen)\b/iu.test(brief) ? "16:9"
    : /\b(?:1:1|square)\b/iu.test(brief) ? "1:1" : "9:16";
  return { shotCount, durationSeconds, aspectRatio };
}

function styledGoalPrompt(plan: GoalPlan, stage: GoalStyleStage, text: string): string {
  const fragment = goalStyleFragment(plan.style, stage);
  return fragment ? `${text}\n\n${fragment}` : text;
}

function goalReferenceName(plan: GoalPlan, index: number): string {
  return plan.storyboardLayout === "six-panel" ? `Reference ${index + 1} (${plan.referenceRoles?.[index] ?? "reference"})` : `Character ${index + 1}`;
}

function goalReferenceLegend(plan: GoalPlan, characters: readonly GoalCharacter[], frame: "full" | null = null): string {
  return `${[...(frame ? [plan.storyboardLayout === "six-panel" ? "@image1 approved scene: keep clothes, props, place" : "@image1 full frame: keep clothes, props"] : []), ...characters.map((_, index) => `@image${index + (frame ? 2 : 1)} ${goalReferenceName(plan, index)}`)].join("; ")}.`;
}

function goalImageStep(id: string, plan: GoalPlan, prompt: string, references: readonly string[]): ChainStep {
  const models = GOAL_IMAGE_MODELS[plan.imageModel];
  return {
    id,
    tool: "generate_image",
    params: {
      model: references.length > 0 ? models.edit : models.text,
      prompt,
      refs: { image: [...references] },
      options: {
        aspect_ratio: plan.aspectRatio,
        resolution: plan.imageResolution,
        ...(plan.imageModel === "nano-banana-2-1" ? { output_format: "png" } : { background: "opaque" }),
      },
    },
  };
}

export function compileFrameSteps(plan: GoalPlan, characters: readonly GoalCharacter[]): ChainStep[] {
  return [goalImageStep(
    "frame",
    plan,
    `${styledGoalPrompt(plan, "frame", `${plan.continuity}\n\n${plan.frame.prompt}`)}\n\n${goalReferenceLegend(plan, characters)}`,
    characters.map(character => character.address),
  )];
}

function storyboardLayoutPrompt(plan: GoalPlan, index: number): string {
  const six = plan.storyboardLayout === "six-panel";
  const beat = plan.shots[index]!.durationSeconds / (six ? 6 : 4);
  const time = (value: number) => six ? Number(value.toFixed(1)) : value;
  const times = Array.from({ length: six ? 6 : 4 }, (_, position) => `${time(position * beat)}–${time((position + 1) * beat)}s`);
  return `${six ? "2 columns by 3 rows, six-panel" : "2x2"} storyboard. Each ${plan.aspectRatio}. Left-right, top-bottom: ${six ? "hook; setup; action; escalation; reaction; payoff" : "setup; action; reaction; ending"}. Below pictures: timing + action/camera notes. Times: ${times.join("; ")}. Pictures text-free.`;
}

export function compileStoryboardSteps(plan: GoalPlan, characters: readonly GoalCharacter[], frame: string, indexes = plan.shots.map((_, index) => index)): ChainStep[] {
  const frames = [...indexes.map(index => ({ index, ending: false })), ...(plan.frameContinuity ? indexes.map(index => ({ index, ending: true })) : [])];
  return frames.map(({ index, ending }) => goalImageStep(
    `storyboard${index + 1 + (ending ? plan.shots.length : 0)}`,
    plan,
    `${styledGoalPrompt(plan, ending ? "ending" : "storyboard", ending ? `Ending frame. ${goalEndingPrompt(plan, index)}` : `${storyboardLayoutPrompt(plan, index)}\n\n${goalStillPrompt(plan, "storyboards", index)}`)}\n\n${goalReferenceLegend(plan, characters, "full")}`,
    [frame, ...characters.map(character => character.address)],
  ));
}

function goalEndingPrompt(plan: GoalPlan, index: number): string {
  const shot = plan.shots[index]!;
  return shot.endingPrompt ?? `Final moment: ${shot.videoPrompt}`;
}

export function goalStillPrompt(plan: GoalPlan, stage: GoalStillStage, index: number): string {
  if (stage === "frame" && index === 0) return plan.frame.prompt;
  if (stage === "storyboards" && index >= 0 && index < plan.shots.length) {
    const shot = plan.shots[index]!;
    return `Shot ${index + 1}: ${shot.title} (${shot.durationSeconds}s). ${shot.storyboardPrompt}${plan.storyboardLayout === "six-panel" ? "" : `\nAction: ${shot.videoPrompt}`}`;
  }
  if (stage === "storyboards" && plan.frameContinuity && index >= plan.shots.length && index < plan.shots.length * 2) return goalEndingPrompt(plan, index - plan.shots.length);
  throw new Error("There is no still at this stage and index");
}

export function compileReviseStillStep(plan: GoalPlan, characters: readonly GoalCharacter[], stage: GoalStillStage, index: number, current: string, feedback: string, frame?: string): ChainStep {
  const basePrompt = goalStillPrompt(plan, stage, index);
  const storyboard = stage === "storyboards" && index < plan.shots.length;
  if (stage === "storyboards" && !frame) throw new Error("Choose a full frame before revising storyboards");
  const references = ["@image1: previous version", ...(frame ? ["@image2: full frame"] : []),
    ...characters.map((_, position) => `@image${position + (frame ? 3 : 2)}: ${goalReferenceName(plan, position)}`)];
  return goalImageStep(
    stage === "frame" ? "frame" : `storyboard${index + 1}`,
    plan,
    `${styledGoalPrompt(plan, "revise", `${storyboard ? `${storyboardLayoutPrompt(plan, index)}\n\n` : ""}${basePrompt}\n\nChange @image1: ${feedback.replace(/[.!?]+$/u, "")}. Keep rest.${storyboard ? plan.storyboardLayout === "six-panel" ? " Six distinct moments." : " Four distinct moments." : ""}`)}\n\n${references.join("; ")}.`,
    [current, ...(frame ? [frame] : []), ...characters.map(character => character.address)],
  );
}

type GoalVideoOptions = { frame?: string; characters?: readonly GoalCharacter[]; indexes?: readonly number[]; feedback?: string | null; assemble?: boolean };

function goalShotParams(plan: GoalPlan, index: number, storyboard: string, ending: string | undefined, options: GoalVideoOptions): Record<string, unknown> {
  const shot = plan.shots[index]!;
  const fragment = goalStyleFragment(plan.style, "video");
  const six = plan.storyboardLayout === "six-panel";
  const references = [storyboard, ...(ending ? [ending] : []), ...(six && options.frame ? [options.frame] : []), ...(six ? (options.characters ?? []).map(character => character.address) : [])];
  const sceneSlot = ending ? 3 : 2;
  const legend = six ? [options.frame ? `@image${sceneSlot} approved scene` : "", ...(options.characters ?? []).map((_, position) => `@image${sceneSlot + (options.frame ? 1 : 0) + position} ${goalReferenceName(plan, position)}`)].filter(Boolean).join("; ") : "";
  return {
    model: GOAL_VIDEO_MODEL,
    prompt: `${shot.videoPrompt}${options.feedback ? `\nRevision: ${options.feedback}` : ""}\n\n@image1 storyboard. ${six ? "Six beats in reading order, follow its timestamps" : `Four beats in order, ${shot.durationSeconds / 4}s each`}. Same people, place. Full-screen.${fragment ? ` ${fragment}` : ""}${ending ? " @image2 ending pose." : ""}${legend ? ` ${legend}.` : ""} No grid, borders, notes, text. No music.`,
    refs: { image: references },
    mode: "r2v",
    options: {
      duration: shot.durationSeconds,
      aspect_ratio: plan.aspectRatio,
      resolution: plan.videoResolution,
      generate_audio: true,
    },
  };
}

export function compileVideoSteps(goalId: string, plan: GoalPlan, storyboards: readonly string[], endings: readonly string[] = [], options: GoalVideoOptions = {}): ChainStep[] {
  if (storyboards.length !== plan.shots.length) throw new Error("Approve a storyboard for every shot before generating videos");
  if (plan.frameContinuity && endings.length !== plan.shots.length) throw new Error("Approve an ending frame for every shot before generating videos");
  const steps: ChainStep[] = [
    ...(options.indexes ?? plan.shots.map((_, index) => index)).map(index => ({
      id: `shot${index + 1}`,
      tool: GOAL_VIDEO_TOOL,
      params: goalShotParams(plan, index, storyboards[index]!, plan.frameContinuity ? endings[index] : undefined, options),
    })),
  ];
  if (plan.shots.length > 1 && options.assemble !== false) steps.push({
      id: "assemble",
      tool: "assemble_goal",
      params: {
        goal_id: goalId,
        artifact_ids: plan.shots.map((_, index) => ({
          $ref: { step_id: `shot${index + 1}`, output: "asset_id" },
        })),
      },
    });
  return steps;
}
