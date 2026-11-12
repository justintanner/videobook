import type { Engine } from "videobook-engine";
import { z } from "zod";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildIntelligenceResponses, firstResponseText, intelligenceRequest } from "../openai-intelligence.js";
import { chatIntelligenceRequestOptions } from "../chat-models.js";
import { readGoal, requireGoalShortContent, saveGoal, writeGoalShortContent, type GoalRecord } from "../goal-store.js";
import { buildGoalShortPlan, type GoalShortDraft } from "../goal-short-plan.js";
import { stripShortBannedWords } from "../goal-short-rules.js";
import { estimateShort } from "../goal-short-runtime.js";
import {
  shortAuthoredCopy, shortPlannerBrief, shortPlannerInstructions, shortPlannerIssues, shortPlannerNeeded, shortPlannerResponseSchema, shortTitle,
  type ShortAuthoredCopy, type ShortPlannerIssue, type ShortPlannerResponse,
} from "../goal-short-planner.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import { goalPlannerImages } from "../goal-reference-images.js";

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
    const estimate = await estimateShort(engine, plan);
    await withNotebookMutation(`goal:${goalId}`, async () => {
      const current = readGoal(engine, goalId);
      if (current.status !== "planning") return;
      const latest = requireGoalShortContent(engine, current);
      await writeGoalShortContent(engine, current, { ...latest, plan, estimate, revision: latest.revision + 1 });
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
    return goal.planVersion === 4 && goal.status === "planning" ? planShortGoal(engine, goalId, context.signal) : { goalId };
  });
}
