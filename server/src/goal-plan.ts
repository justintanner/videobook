import { z } from "zod";
import type { ChainStep } from "./chain-plan.js";
import type { GptImage25Variant } from "./gpt-image-2-5.js";

export const GOAL_VIDEO_TOOL = "generate_kie_seedance_2_5_video";
export const GOAL_IMAGE_TOOLS: Record<GptImage25Variant, string> = {
  sunburst: "generate_kie_gpt_image_2_5_sunburst_image",
  flare: "generate_kie_gpt_image_2_5_flare_image",
};
const GOAL_MAX_SHOTS = 8;
const goalPrompt = (limit: number) => z.string().trim().min(1).max(limit)
  .regex(/^[^@]*$/u, "Use Character 1, Character 2 and plain text in plan prompts; input references are added automatically");

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
  title: goalPrompt(120),
  continuity: goalPrompt(3000),
  imageModel: z.enum(["sunburst", "flare"]).default("sunburst"),
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

export type GoalPlan = z.infer<typeof goalPlanSchema>;
export type LegacyGoalPlan = z.infer<typeof legacyGoalPlanSchema>;
export type GoalDisplayPlan = GoalPlan | LegacyGoalPlan;
export type GoalStage = "frame" | "storyboards" | "videos" | "assembly";
export type GoalGenerationStage = Exclude<GoalStage, "assembly">;
export type GoalCharacter = { artifactId: string; cellId: string; address: string; label: string };

export function goalBriefConstraints(brief: string): {
  shotCount: number;
  durationSeconds: number;
  aspectRatio: GoalPlan["aspectRatio"];
} {
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12,
  };
  const count = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:(?:\d+(?:\.\d+)?)[ -]*(?:s|secs?|seconds?)[ -]*)?(?:(?:short|funny|comedic|cinematic|animated|portrait|vertical|square|landscape|horizontal)[ -]+){0,3}(?:clips?|shots?|scenes?)\b/iu.exec(brief);
  const multiplier = /\b(\d+)\s*[x×]\s*(\d+)\s*(?:s|secs?|seconds?)\b/iu.exec(brief);
  const clipDuration = /\b(\d+(?:\.\d+)?)[ -]*(?:s|secs?|seconds?)[ -]*(?:clips?|shots?|scenes?|each)\b/iu.exec(brief)
    ?? /\b(?:clips?|shots?|scenes?)\s+(?:of\s+)?(\d+(?:\.\d+)?)[ -]*(?:s|secs?|seconds?)\b/iu.exec(brief);
  const duration = /\b(\d+(?:\.\d+)?)[ -]*(?:s|secs?|seconds?)\b/iu.exec(brief);
  const shotCount = count ? words[count[1]!.toLowerCase()] ?? Number(count[1])
    : multiplier ? Number(multiplier[1]) : /\b(?:single|one)\s+(?:video|clip|shot)\b/iu.test(brief) ? 1 : 3;
  const durationSeconds = multiplier ? Number(multiplier[2]) : clipDuration ? Number(clipDuration[1]) : duration ? Number(duration[1]) : 10;
  if (!Number.isInteger(shotCount) || shotCount < 1 || shotCount > GOAL_MAX_SHOTS) {
    throw new Error(`A goal supports 1–${GOAL_MAX_SHOTS} clips. Choose a smaller shot count.`);
  }
  if (!Number.isInteger(durationSeconds) || durationSeconds < 4 || durationSeconds > 30) {
    throw new Error("Each goal clip must be a whole number of seconds from 4 to 30.");
  }
  const aspectRatio = /\b(?:9:16|portrait|vertical)\b/iu.test(brief) ? "9:16"
    : /\b(?:1:1|square)\b/iu.test(brief) ? "1:1" : "16:9";
  return { shotCount, durationSeconds, aspectRatio };
}

function goalReferenceLegend(characters: readonly GoalCharacter[], frame: "full" | "first" | "pair" | null = null): string {
  if (frame === "pair") return "References: @firstframe is this shot's approved starting storyboard and @lastframe is its approved ending storyboard. Begin and end with those compositions while preserving character identities, clothing and setting.";
  if (frame === "first") return "References: @firstframe is this shot's approved storyboard; begin with its composition and preserve the characters' identities, clothing and setting.";
  const references = characters.map((character, index) => `@image${index + (frame === "full" ? 2 : 1)} is Character ${index + 1}: ${character.label.replace(/@[\p{L}\p{N}_-]+/gu, "").slice(0, 160)}`);
  if (frame === "full") references.unshift("@image1 is the approved full frame; preserve its setting and visual style");
  return `References: ${references.join("; ")}.`;
}

function goalFrameParams(plan: GoalPlan, characters: readonly GoalCharacter[]): Record<string, unknown> {
  return {
    prompt: `${plan.continuity}\n\n${plan.frame.prompt}\n\n${goalReferenceLegend(characters)}`,
    image_refs: characters.map(character => character.address),
    aspect_ratio: plan.aspectRatio,
    resolution: plan.imageResolution,
    background: "opaque",
  };
}

export function compileFrameSteps(plan: GoalPlan, characters: readonly GoalCharacter[]): ChainStep[] {
  return [{ id: "frame", tool: GOAL_IMAGE_TOOLS[plan.imageModel], params: goalFrameParams(plan, characters) }];
}

export function compileStoryboardSteps(plan: GoalPlan, characters: readonly GoalCharacter[], frame: string, indexes = plan.shots.map((_, index) => index)): ChainStep[] {
  const frames = [...indexes.map(index => ({ index, ending: false })), ...(plan.frameContinuity ? indexes.map(index => ({ index, ending: true })) : [])];
  return frames.map(({ index, ending }) => ({
    id: `storyboard${index + 1 + (ending ? plan.shots.length : 0)}`,
    tool: GOAL_IMAGE_TOOLS[plan.imageModel],
    params: {
      prompt: `${plan.continuity}\n\nShot ${index + 1}: ${plan.shots[index]!.title}\n${ending ? goalEndingPrompt(plan, index) : plan.shots[index]!.storyboardPrompt}\n\n${goalReferenceLegend(characters, "full")}`,
      image_refs: [frame, ...characters.map(character => character.address)],
      aspect_ratio: plan.aspectRatio,
      resolution: plan.imageResolution,
      background: "opaque",
    },
  }));
}

function goalEndingPrompt(plan: GoalPlan, index: number): string {
  const shot = plan.shots[index]!;
  const next = plan.shots[index + 1];
  return `Create one still image of the final moment of this shot, with the characters in their ending poses. ${shot.endingPrompt ?? shot.videoPrompt}${next ? `\nPrepare a natural transition into the next shot's opening composition: ${next.storyboardPrompt}` : "\nShow the final payoff with a clear, settled composition."}`;
}

function goalShotParams(plan: GoalPlan, index: number, characters: readonly GoalCharacter[], storyboard: string, ending?: string): Record<string, unknown> {
  const shot = plan.shots[index]!;
  return {
    prompt: `${plan.continuity}\n\nShot ${index + 1} of ${plan.shots.length}: ${shot.title}\n${shot.videoPrompt}\n\n${goalReferenceLegend(characters, ending ? "pair" : "first")}`,
    first_frame_ref: storyboard,
    ...(ending ? { last_frame_ref: ending } : {}),
    duration: String(shot.durationSeconds),
    aspect_ratio: plan.aspectRatio,
    resolution: plan.videoResolution,
    generate_audio: true,
  };
}

export function compileVideoSteps(goalId: string, plan: GoalPlan, characters: readonly GoalCharacter[], storyboards: readonly string[], endings: readonly string[] = []): ChainStep[] {
  if (storyboards.length !== plan.shots.length) throw new Error("Approve a storyboard for every shot before generating videos");
  if (plan.frameContinuity && endings.length !== plan.shots.length) throw new Error("Approve an ending storyboard for every shot before generating videos");
  const steps: ChainStep[] = [
    ...plan.shots.map((_, index) => ({
      id: `shot${index + 1}`,
      tool: GOAL_VIDEO_TOOL,
      params: goalShotParams(plan, index, characters, storyboards[index]!, plan.frameContinuity ? endings[index] : undefined),
    })),
  ];
  if (plan.shots.length > 1) steps.push({
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
