import { GOAL_PROMPT_BUDGET, goalBriefConstraints, type GoalPlan } from "./goal-plan.js";
import { goalStyle, goalStyleSummary, resolveGoalStyleOptions, type GoalStyleSelection } from "./goal-styles.js";

const cinematicInstructions = `Plan video. Return version 2 JSON. Barebones prompts: short noun/verb fragments, present tense. No filler, prose, jargon lists or stacked adjectives. Number characters. Continuity: identity, props, place, style once. Frame: all characters together. Storyboard: four distinct numbered beats in a 2x2 sheet, setup/action/reaction/ending. Let the storyboard guide the video. videoPrompt: only essential motion and sound; do not retell the panels. Opening, escalation, payoff. Word ceilings, not targets: title ${GOAL_PROMPT_BUDGET.title}, continuity ${GOAL_PROMPT_BUDGET.continuity}, frame ${GOAL_PROMPT_BUDGET.frame}, storyboard ${GOAL_PROMPT_BUDGET.storyboard}, ending ${GOAL_PROMPT_BUDGET.ending}, video ${GOAL_PROMPT_BUDGET.video}. Match shot count, seconds and aspect ratio. Portrait default; centre subjects, leave headroom. Sunburst, 2K, 720p unless specified. frameContinuity false; endingPrompt null. No @tokens, tools, invented assets or continuity promises.`;

export function goalPlannerInstructions(selection: GoalStyleSelection, constraints: ReturnType<typeof goalBriefConstraints>): string {
  const style = goalStyle(selection.id);
  if (!style.planner) return cinematicInstructions;
  const options = resolveGoalStyleOptions(selection.id, selection.options);
  const beats = style.options.find(option => option.key === "format")?.choices.find(choice => choice.value === options.format)?.beats;
  return `${cinematicInstructions}\n\n${style.planner} Selected style: ${goalStyleSummary(selection)}. Four beats: ${beats}. Use ${constraints.aspectRatio} throughout.`;
}

export function constrainGoalPlannerPlan(plan: GoalPlan, brief: string, selection: GoalStyleSelection): GoalPlan {
  const constraints = goalBriefConstraints(brief);
  if (plan.shots.length !== constraints.shotCount) throw new Error("The planner returned a different shot count. Try planning again.");
  const defaults = goalStyle(selection.id).defaults;
  const imageModel = /\b(flare|sunburst)\b/iu.exec(brief)?.[1]?.toLowerCase() as GoalPlan["imageModel"] | undefined;
  const imageResolution = /\b(1k|2k)\b/iu.exec(brief)?.[1]?.toUpperCase() as GoalPlan["imageResolution"] | undefined;
  const videoResolution = /\b(480p|720p)\b/iu.exec(brief)?.[1]?.toLowerCase() as GoalPlan["videoResolution"] | undefined;
  return {
    ...plan, style: { id: selection.id, options: resolveGoalStyleOptions(selection.id, selection.options) },
    aspectRatio: constraints.aspectRatio, frameContinuity: false,
    imageModel: imageModel ?? defaults.imageModel ?? plan.imageModel,
    imageResolution: imageResolution ?? defaults.imageResolution ?? plan.imageResolution,
    videoResolution: videoResolution ?? defaults.videoResolution ?? plan.videoResolution,
    shots: plan.shots.map(shot => ({ ...shot, durationSeconds: constraints.durationSeconds, endingPrompt: null })),
  };
}
