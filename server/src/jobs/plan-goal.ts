import type { Engine } from "videobook-engine";
import { z } from "zod";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildIntelligenceResponses, firstResponseText, intelligenceRequest } from "../openai-intelligence.js";
import { chatIntelligenceRequestOptions } from "../chat-models.js";
import { goalBriefConstraints, goalPlannerResponseSchema, goalPromptBudgetIssues, compileFrameSteps, compileStoryboardSteps, compileVideoSteps, type GoalCharacter, type GoalPlan } from "../goal-plan.js";
import { goalPlannerBrief } from "../goal-characters.js";
import { goalBriefStyle, goalStyle } from "../goal-styles.js";
import { constrainGoalPlannerPlan, goalPlannerInstructions } from "../goal-planner-prompt.js";
import { readAssetTagSummaries } from "../asset-tags.js";
import { readGoal, requireGoalContent, requireGoalShortContent, saveGoal, writeGoalContent, writeGoalShortContent } from "../goal-store.js";
import type { GoalEstimate, GoalEstimates, GoalRecord } from "../goal-store.js";
import { buildGoalShortPlan, type GoalShortDraft } from "../goal-short-plan.js";
import { stripShortBannedWords } from "../goal-short-rules.js";
import {
  shortAuthoredCopy, shortPlannerBrief, shortPlannerInstructions, shortPlannerIssues, shortPlannerNeeded, shortPlannerResponseSchema, shortTitle,
  type ShortAuthoredCopy, type ShortPlannerIssue, type ShortPlannerResponse,
} from "../goal-short-planner.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import { assessToolCallEstimate } from "./cost-estimate-assessment.js";
import { goalPlannerImages } from "../goal-reference-images.js";

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
    videos: compileVideoSteps("estimate", plan, plan.shots.map(() => reference), plan.frameContinuity ? plan.shots.map(() => reference) : []).filter(step => step.id !== "assemble"),
  };
  const estimated = await Promise.all(Object.values(groups).map(async steps => sumEstimates(await Promise.all(steps.map(async step => {
    const estimate = await assessToolCallEstimate(engine, step.tool, { book_id: engine.book.get().bookId, ...step.params });
    return { usd: estimate.available ? estimate.usd : null, warnings: estimate.warnings };
  })))));
  return { frame: estimated[0]!, storyboards: estimated[1]!, videos: estimated[2]!, total: sumEstimates(estimated) };
}

const shortPlannerAnswerSchema = z.object({ title: z.string(), frame: z.string(), beats: z.array(z.string()) });

function shortPlannerAnswer(text: string): ShortPlannerResponse | null {
  try {
    const parsed = shortPlannerAnswerSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function withoutBannedWords(answer: ShortPlannerResponse, authored: ShortAuthoredCopy): ShortPlannerResponse {
  return {
    title: stripShortBannedWords(answer.title),
    frame: authored.frame === null ? stripShortBannedWords(answer.frame) : answer.frame,
    beats: answer.beats.map((beat, index) => authored.beats[index] == null ? stripShortBannedWords(beat) : beat),
  };
}

async function askShortPlanner(engine: Engine, goal: GoalRecord, brief: string, draft: GoalShortDraft, authored: ShortAuthoredCopy, signal: AbortSignal): Promise<ShortPlannerResponse> {
  const notebook = engine.notebooks.read(goal.notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  const references = [...draft.character.references, ...draft.extraReferences];
  const count = draft.segmentSeconds.length;
  const options = chatIntelligenceRequestOptions();
  const responses = buildIntelligenceResponses(requireApiKey("OPENAI_API_KEY"), options);
  const fixedBeats = authored.beats.flatMap((beat, index) => beat === null ? [] : [[`beat ${index + 1}`, beat] as const]);
  const request = {
    instructions: await shortPlannerInstructions({ character: draft.character, aspectRatio: draft.aspectRatio, segmentSeconds: draft.segmentSeconds }),
    input: [{ role: "user" as const, content: [
      { type: "input_text" as const, text: JSON.stringify({
        brief: shortPlannerBrief(brief, references, notebook.value),
        character: { name: draft.character.name, description: draft.character.description },
        aspectRatio: draft.aspectRatio,
        segments: draft.segmentSeconds.map((seconds, index) => ({ beat: index + 1, seconds })),
        fixed: Object.fromEntries([...(authored.frame === null ? [] : [["frame", authored.frame] as const]), ...fixedBeats]),
        write: ["title", ...(authored.frame === null ? ["frame"] : []), ...authored.beats.flatMap((beat, index) => beat === null ? [`beat ${index + 1}`] : [])],
      }) },
      ...await goalPlannerImages(engine, references),
    ] }],
    text: { format: { type: "json_schema" as const, name: "short_plan", strict: true, schema: z.toJSONSchema(shortPlannerResponseSchema(count)) } },
    max_output_tokens: 2000,
  };
  const first = shortPlannerAnswer(firstResponseText(await responses(intelligenceRequest(request, options), signal)));
  const firstIssues: ShortPlannerIssue[] = first
    ? shortPlannerIssues(first, count, authored)
    : [{ kind: "count", message: "Answer with JSON holding a title, a frame and the beats." }];
  if (first && firstIssues.length === 0) return first;
  const revised = await responses(intelligenceRequest({
    ...request,
    input: [...request.input, {
      role: "user" as const,
      content: `Fix these problems and answer again with the whole plan: ${firstIssues.map((issue) => issue.message).join(" ")}${first ? `\nYour previous answer: ${JSON.stringify(first)}` : ""}`,
    }],
  }, options), signal);
  const second = shortPlannerAnswer(firstResponseText(revised));
  if (!second) throw new Error("The planner did not answer with a plan. Try planning again.");
  const blocking = shortPlannerIssues(second, count, authored).filter((issue) => issue.kind !== "banned");
  if (blocking.length > 0) throw new Error(`The planner's plan still breaks its limits. ${blocking.map((issue) => issue.message).join(" ")} Try planning again.`);
  const cleaned = withoutBannedWords(second, authored);
  if (shortPlannerIssues({ ...cleaned, title: cleaned.title || "Short" }, count, authored).some((issue) => issue.kind === "empty")) {
    throw new Error("The planner's plan was empty without its banned words. Try planning again.");
  }
  return cleaned;
}

async function planShortGoal(engine: Engine, goalId: string, signal: AbortSignal): Promise<{ goalId: string }> {
  try {
    const goal = readGoal(engine, goalId);
    const content = requireGoalShortContent(engine, goal);
    const { draft } = content;
    if (!draft) throw new Error("This short has nothing to plan. Start a new /goal.");
    const authored = shortAuthoredCopy(content.brief, draft.segmentSeconds.length);
    const written = shortPlannerNeeded(content.brief, draft.segmentSeconds.length)
      ? await askShortPlanner(engine, goal, content.brief, draft, authored, signal)
      : null;
    const framePrompt = authored.frame ?? written?.frame ?? "";
    const plan = buildGoalShortPlan({
      ...draft,
      title: written?.title || shortTitle(content.brief, framePrompt),
      framePrompt,
      beats: authored.beats.map((beat, index) => beat ?? written?.beats[index] ?? ""),
    });
    await withNotebookMutation(`goal:${goalId}`, async () => {
      const current = readGoal(engine, goalId);
      if (current.status !== "planning") return;
      const latest = requireGoalShortContent(engine, current);
      await writeGoalShortContent(engine, current, { ...latest, plan, revision: latest.revision + 1 });
      saveGoal(engine, { ...current, stage: "frame", status: "review", error: null });
    });
    return { goalId };
  } catch (error) {
    await withNotebookMutation(`goal:${goalId}`, async () => {
      const current = readGoal(engine, goalId);
      if (current.status === "planning") saveGoal(engine, { ...current, status: "failed", error: error instanceof Error ? error.message : String(error) });
    });
    throw error;
  }
}

export function registerPlanGoalJob(engine: Engine): void {
  registerJobHandler("plan_goal", async (payload, context) => {
    const goalId = String(payload.goalId);
    const goal = readGoal(engine, goalId);
    if (goal.planVersion === 4) return goal.status === "planning" ? planShortGoal(engine, goalId, context.signal) : { goalId };
    if (goal.planVersion !== 2 || goal.status !== "planning") return { goalId };
    try {
      const { brief, characters, requestedStyle } = requireGoalContent(engine, goal);
      const style = requestedStyle ?? goalBriefStyle(brief);
      const constraints = goalBriefConstraints(brief);
      const tags = readAssetTagSummaries(engine, characters.map(character => character.artifactId));
      const notebook = engine.notebooks.read(goal.notebookId);
      if (!notebook.ok) throw new Error(notebook.error.message);
      const responses = buildIntelligenceResponses(requireApiKey("OPENAI_API_KEY"), chatIntelligenceRequestOptions());
      const request = {
        instructions: goalPlannerInstructions(style, constraints),
        input: [{ role: "user" as const, content: [
          { type: "input_text" as const, text: JSON.stringify({ brief: goalPlannerBrief(brief, characters, notebook.value).replace(/Character (\d+)/gu, "Reference $1"), style: { ...style, label: goalStyle(style.id).label }, references: characters.map((character, index) => ({ name: `Reference ${index + 1}`, label: character.label, tags: tags.get(character.artifactId)?.effective ?? [] })), ...constraints }) },
          ...await goalPlannerImages(engine, characters),
        ] }],
        text: { format: { type: "json_schema" as const, name: "video_goal_plan", strict: true, schema: z.toJSONSchema(goalPlannerResponseSchema.omit({ style: true })) } },
        max_output_tokens: 2500,
      };
      const response = await responses(intelligenceRequest(request, chatIntelligenceRequestOptions()), context.signal);
      let plan: GoalPlan = goalPlannerResponseSchema.parse(JSON.parse(firstResponseText(response)));
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
      plan = constrainGoalPlannerPlan(plan, brief, style);
      plan.referenceRoles = characters.map((_, index) => plan.referenceRoles?.[index] ?? "reference");
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
