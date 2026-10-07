import type { Engine } from "videobook-engine";
import { z } from "zod";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildIntelligenceResponses, firstResponseText, intelligenceRequest } from "../openai-intelligence.js";
import { chatIntelligenceRequestOptions } from "../chat-models.js";
import { goalBriefConstraints, goalPlanSchema, compileFrameSteps, compileStoryboardSteps, compileVideoSteps, type GoalCharacter, type GoalPlan } from "../goal-plan.js";
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
    videos: compileVideoSteps("estimate", plan, pins, plan.shots.map(() => reference)).filter(step => step.id !== "assemble"),
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
      const response = await responses(intelligenceRequest({
        instructions: "Plan a coherent short video using the supplied character images. Return the version 2 JSON plan. Refer to each character by its numbered role and described look. Continuity defines every character, props, setting and visual style. The frame prompt describes one full frame showing all characters together. Each storyboardPrompt describes a still frame with composition, blocking and expressions consistent with the full frame. Each videoPrompt describes action, camera movement and sound with a clear beginning and ending that fits its duration. Build an opening, escalation and payoff where appropriate. Respect shot count, duration and aspect ratio exactly. Use Sunburst, 2K images and 720p video unless requested otherwise. Never put @tokens or grid addresses in prompts; the compiler adds references. Do not run tools, claim media was generated, invent external assets or promise perfect continuity.",
        input: [{ role: "user", content: JSON.stringify({ brief: goalPlannerBrief(brief, characters, notebook.value), characters: characters.map((character, index) => ({ role: `Character ${index + 1}`, label: character.label, tags: tags.get(character.artifactId)?.effective ?? [] })), ...constraints }) }],
        text: { format: { type: "json_schema", name: "video_goal_plan", strict: true, schema: z.toJSONSchema(goalPlanSchema) } },
        max_output_tokens: 8000,
      }, chatIntelligenceRequestOptions()), context.signal);
      const plan = goalPlanSchema.parse(JSON.parse(firstResponseText(response)));
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
