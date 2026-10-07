import type { Engine } from "videobook-engine";
import { z } from "zod";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildIntelligenceResponses, firstResponseText, intelligenceRequest } from "../openai-intelligence.js";
import { chatIntelligenceRequestOptions } from "../chat-models.js";
import { GOAL_PROMPT_BUDGET, goalBriefConstraints, goalPlannerResponseSchema, goalPromptBudgetIssues, compileFrameSteps, compileStoryboardSteps, compileVideoSteps, type GoalCharacter, type GoalPlan } from "../goal-plan.js";
import { goalPlannerBrief } from "../goal-characters.js";
import { readAssetTagSummaries } from "../asset-tags.js";
import { readGoal, requireGoalContent, saveGoal, writeGoalContent } from "../goal-store.js";
import type { GoalEstimate, GoalEstimates } from "../goal-store.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import { assessToolCallEstimate } from "./cost-estimate-assessment.js";

function sumEstimates(estimates: GoalEstimate[]): GoalEstimate {
  return {
    usd: estimates.every(estimate => estimate.usd !== null)
      ? estimates.reduce((sum, estimate) => sum + (estimate.usd ?? 0), 0) : null,
    warnings: [...new Set(estimates.flatMap((estimate) => estimate.warnings))],
  };
}

export async function estimateGoal(engine: Engine, plan: GoalPlan, characters: readonly GoalCharacter[]): Promise<GoalEstimates> {
  const reference = characters[0]?.artifactId ?? "";
  const pins = characters.map(character => ({ ...character, address: character.artifactId }));
  const groups = {
    frame: compileFrameSteps(plan, pins),
    storyboards: compileStoryboardSteps(plan, pins, reference),
    videos: compileVideoSteps("estimate", plan, pins, plan.shots.map(() => reference), plan.frameContinuity ? plan.shots.map(() => reference) : []).filter(step => step.id !== "assemble"),
  };
  const estimated = await Promise.all(Object.values(groups).map(async steps => sumEstimates(await Promise.all(steps.map(async step => {
    const estimate = await assessToolCallEstimate(engine, step.tool, { book_id: engine.book.get().bookId, ...step.params });
    return { usd: estimate.available ? estimate.usd : null, warnings: estimate.warnings };
  })))));
  return { frame: estimated[0]!, storyboards: estimated[1]!, videos: estimated[2]!, total: sumEstimates(estimated) };
}

export function registerPlanGoalJob(engine: Engine): void {
  registerJobHandler("plan_goal", async (payload, context) => {
    const goalId = String(payload.goalId);
    const goal = readGoal(engine, goalId);
    if (goal.planVersion !== 2 || goal.status !== "planning") return { goalId };
    try {
      const { brief, characters } = requireGoalContent(engine, goal);
      const constraints = goalBriefConstraints(brief);
      const tags = readAssetTagSummaries(engine, characters.map(character => character.artifactId));
      const notebook = engine.notebooks.read(goal.notebookId);
      if (!notebook.ok) throw new Error(notebook.error.message);
      const responses = buildIntelligenceResponses(requireApiKey("OPENAI_API_KEY"), chatIntelligenceRequestOptions());
      const request = {
        instructions: `Plan a coherent short video using the supplied character images. Return the version 2 JSON plan. Use concrete visual nouns and present tense, one action per shot, and one short sound clause per video prompt. No camera-jargon lists or stacked adjectives. Refer to numbered characters. Continuity defines their looks, props, setting and style; never repeat it in shot prompts. The frame shows all characters together. Storyboards describe still compositions and expressions; videos describe an action with a clear ending within the duration. Build an opening, escalation and payoff. Word limits: title ${GOAL_PROMPT_BUDGET.title}, continuity ${GOAL_PROMPT_BUDGET.continuity}, frame ${GOAL_PROMPT_BUDGET.frame}, storyboard ${GOAL_PROMPT_BUDGET.storyboard}, ending ${GOAL_PROMPT_BUDGET.ending}, video ${GOAL_PROMPT_BUDGET.video}. Respect shot count, duration and aspect ratio exactly. Default to portrait 9:16; compose vertically with centred or stacked subjects and headroom when using 9:16. Use Sunburst, 2K images and 720p video unless requested otherwise. Set frameContinuity to false and endingPrompt to null. Never put @tokens or grid addresses in prompts; the compiler adds references. Do not run tools, claim media was generated, invent assets or promise perfect continuity.`,
        input: [{ role: "user" as const, content: JSON.stringify({ brief: goalPlannerBrief(brief, characters, notebook.value), characters: characters.map((character, index) => ({ role: `Character ${index + 1}`, label: character.label, tags: tags.get(character.artifactId)?.effective ?? [] })), ...constraints }) }],
        text: { format: { type: "json_schema" as const, name: "video_goal_plan", strict: true, schema: z.toJSONSchema(goalPlannerResponseSchema) } },
        max_output_tokens: 2500,
      };
      const response = await responses(intelligenceRequest(request, chatIntelligenceRequestOptions()), context.signal);
      let plan = goalPlannerResponseSchema.parse(JSON.parse(firstResponseText(response)));
      const budgetIssues = goalPromptBudgetIssues(plan);
      if (budgetIssues.length > 0) {
        const revised = await responses(intelligenceRequest({
          ...request,
          input: [...request.input, { role: "user", content: `Shorten this plan while preserving its meaning: ${JSON.stringify(plan)}\nFix these word limits: ${budgetIssues.join(" ")}` }],
        }, chatIntelligenceRequestOptions()), context.signal);
        const parsed = goalPlannerResponseSchema.safeParse(JSON.parse(firstResponseText(revised)));
        if (!parsed.success || goalPromptBudgetIssues(parsed.data).length > 0) throw new Error("The planner wrote prompts that are too long. Try planning again.");
        plan = parsed.data;
      }
      plan.frameContinuity = false;
      if (plan.shots.length !== constraints.shotCount) throw new Error("The planner returned a different shot count. Try planning again.");
      plan.aspectRatio = constraints.aspectRatio;
      plan.shots = plan.shots.map((shot) => ({ ...shot, durationSeconds: constraints.durationSeconds }));
      const estimate = await estimateGoal(engine, plan, characters);
      await withNotebookMutation(`goal:${goalId}`, async () => {
        const current = readGoal(engine, goalId);
        if (current.status !== "planning") return;
        const content = requireGoalContent(engine, current);
        await writeGoalContent(engine, current, { ...content, plan, estimate, revision: content.revision + 1 });
        saveGoal(engine, { ...current, stage: "frame", status: "review", error: null });
      });
      return { goalId };
    } catch (error) {
      await withNotebookMutation(`goal:${goalId}`, async () => {
        const current = readGoal(engine, goalId);
        if (current.status === "planning") saveGoal(engine, {
          ...current, status: "failed", error: error instanceof Error ? error.message : String(error),
        });
      });
      throw error;
    }
  });
}
