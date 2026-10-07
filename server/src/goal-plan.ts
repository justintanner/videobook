import { z } from "zod";
import type { ChainStep } from "./chain-plan.js";

export const GOAL_VIDEO_TOOL = "generate_kie_seedance_2_5_video";
const GOAL_MAX_SHOTS = 8;

export const goalPlanSchema = z.object({
  title: z.string().trim().min(1).max(120),
  continuity: z.string().trim().min(1).max(3000),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
  shots: z.array(z.object({
    title: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(6000),
    durationSeconds: z.number().int().min(4).max(30),
  })).min(1).max(GOAL_MAX_SHOTS),
}).strict();

export type GoalPlan = z.infer<typeof goalPlanSchema>;

export function goalBriefConstraints(brief: string): {
  shotCount: number;
  durationSeconds: number;
  aspectRatio: GoalPlan["aspectRatio"];
} {
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12,
  };
  const count = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:(?:\d+(?:\.\d+)?)[ -]*(?:s|secs?|seconds?)[ -]*)?(?:clips?|shots?|scenes?)\b/iu.exec(brief);
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

export function goalShotParams(plan: GoalPlan, index: number): Record<string, unknown> {
  const shot = plan.shots[index]!;
  return {
    prompt: `${plan.continuity}\n\nShot ${index + 1} of ${plan.shots.length}: ${shot.title}\n${shot.prompt}`,
    duration: String(shot.durationSeconds),
    aspect_ratio: plan.aspectRatio,
    resolution: "720p",
    generate_audio: true,
  };
}

export function compileGoalSteps(goalId: string, plan: GoalPlan): ChainStep[] {
  return [
    ...plan.shots.map((_, index) => ({
      id: `shot${index + 1}`,
      tool: GOAL_VIDEO_TOOL,
      params: goalShotParams(plan, index),
    })),
    {
      id: "assemble",
      tool: "assemble_goal",
      params: {
        goal_id: goalId,
        artifact_ids: plan.shots.map((_, index) => ({
          $ref: { step_id: `shot${index + 1}`, output: "asset_id" },
        })),
      },
    },
  ];
}
