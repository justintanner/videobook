import { GOAL_PROMPT_BUDGET, goalBriefConstraints, type GoalPlan } from "./goal-plan.js";
import { goalStyle, goalStyleSummary, resolveGoalStyleOptions, type GoalStyleSelection } from "./goal-styles.js";

const cinematicInstructions = `Plan video. Return version 2 JSON. Barebones prompts: short noun/verb fragments, present tense. No filler, prose, jargon lists or stacked adjectives. Name inputs Reference 1, Reference 2. Infer referenceRoles in input order: scene, character, prop or reference; use actual pixels and the brief. Continuity: identity, props, place, style once. Frame: the edited scene with the requested characters and props. storyboardLayout: six-panel. Storyboard: six semicolon-separated action/camera notes, hook/setup/action/escalation/reaction/payoff; 2 columns by 3 rows with timestamps and shot notes below pictures. Let the storyboard guide the video. videoPrompt: only essential motion and sound; do not retell the panels. Sound: ambience or speech. No music. Opening, escalation, payoff. Word ceilings, not targets: title ${GOAL_PROMPT_BUDGET.title}, continuity ${GOAL_PROMPT_BUDGET.continuity}, frame ${GOAL_PROMPT_BUDGET.frame}, storyboard 48, ending ${GOAL_PROMPT_BUDGET.ending}, video ${GOAL_PROMPT_BUDGET.video}. Match shot count, seconds and aspect ratio. Portrait default; centre subjects, leave headroom. Nano Banana 2.1, 2K, Seedance 2.5 720p unless specified. One continuous 20-second video by default; create multiple clips only when explicitly requested. frameContinuity false; endingPrompt null. No @tokens, tools, invented assets or continuity promises.`;

export function goalPlannerInstructions(selection: GoalStyleSelection, constraints: ReturnType<typeof goalBriefConstraints>): string {
  const style = goalStyle(selection.id);
  if (!style.planner) return cinematicInstructions;
  const options = resolveGoalStyleOptions(selection.id, selection.options);
  const beats = style.options.find(option => option.key === "format")?.choices.find(choice => choice.value === options.format)?.beats;
  return `${cinematicInstructions}\n\n${style.planner} Selected style: ${goalStyleSummary(selection)}.${beats ? ` Content arc: ${beats}; expand to six beats.` : ""} Use ${constraints.aspectRatio} throughout.`;
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
    aspectRatio: constraints.aspectRatio, frameContinuity: false, storyboardLayout: "six-panel",
    imageModel: imageModel ?? "nano-banana-2-1",
    imageResolution: imageResolution ?? defaults.imageResolution ?? "2K",
    videoResolution: videoResolution ?? defaults.videoResolution ?? "720p",
    shots: plan.shots.map(shot => ({ ...shot, durationSeconds: constraints.durationSeconds, endingPrompt: null })),
  };
}
