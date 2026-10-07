import type { Engine } from "videobook-engine";
import { z } from "zod";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildIntelligenceResponses, firstResponseText, intelligenceRequest } from "../openai-intelligence.js";
import { chatIntelligenceRequestOptions } from "../chat-models.js";
import { goalBriefConstraints, goalPlanSchema, goalShotParams, GOAL_VIDEO_TOOL, type GoalPlan } from "../goal-plan.js";
import { readGoal, requireGoalContent, saveGoal, writeGoalContent } from "../goal-store.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import { assessToolCallEstimate } from "./cost-estimate-assessment.js";

export async function estimateGoal(engine: Engine, plan: GoalPlan) {
  const estimates = await Promise.all(plan.shots.map((_, index) =>
    assessToolCallEstimate(engine, GOAL_VIDEO_TOOL, {
      book_id: engine.book.get().bookId, ...goalShotParams(plan, index),
    })));
  return {
    usd: estimates.every((estimate) => estimate.available)
      ? estimates.reduce((sum, estimate) => sum + (estimate.usd ?? 0), 0) : null,
    warnings: [...new Set(estimates.flatMap((estimate) => estimate.warnings))],
  };
}

export function registerPlanGoalJob(engine: Engine): void {
  registerJobHandler("plan_goal", async (payload, context) => {
    const goalId = String(payload.goalId);
    const goal = readGoal(engine, goalId);
    if (goal.status !== "planning") return { goalId };
    try {
      const brief = requireGoalContent(engine, goal).brief;
      const constraints = goalBriefConstraints(brief);
      const responses = buildIntelligenceResponses(requireApiKey("OPENAI_API_KEY"), chatIntelligenceRequestOptions());
      const response = await responses(intelligenceRequest({
        instructions: "Plan a coherent short video as distinct, filmable shots. Return the requested JSON shot plan. Use the brief as creative direction. Do not run tools or claim any video has been generated. The continuity field must define the same characters, appearance, props, setting and visual style for every shot. Each prompt must describe concrete action, camera movement and sound with a clear beginning and ending, fitting the clip duration. Build an opening, escalation and payoff where appropriate. Respect the supplied shot count, duration and aspect ratio exactly. Do not put grid addresses or unresolved references in prompts. Do not invent external assets or promise perfect visual continuity.",
        input: [{ role: "user", content: JSON.stringify({ brief, ...constraints }) }],
        text: { format: { type: "json_schema", name: "video_goal_plan", strict: true, schema: z.toJSONSchema(goalPlanSchema) } },
        max_output_tokens: 8000,
      }, chatIntelligenceRequestOptions()), context.signal);
      const plan = goalPlanSchema.parse(JSON.parse(firstResponseText(response)));
      if (plan.shots.length !== constraints.shotCount) throw new Error("The planner returned a different shot count. Try planning again.");
      plan.aspectRatio = constraints.aspectRatio;
      plan.shots = plan.shots.map((shot) => ({ ...shot, durationSeconds: constraints.durationSeconds }));
      const estimate = await estimateGoal(engine, plan);
      await withNotebookMutation(`goal:${goalId}`, async () => {
        const current = readGoal(engine, goalId);
        if (current.status !== "planning") return;
        const content = requireGoalContent(engine, current);
        await writeGoalContent(engine, current, { ...content, plan, estimate, revision: content.revision + 1 });
        saveGoal(engine, { ...current, status: "review", error: null });
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
