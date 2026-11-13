import type { Engine } from "videobook-engine";
import { z } from "zod";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildIntelligenceResponses, firstResponseText, intelligenceRequest } from "../openai-intelligence.js";
import { chatIntelligenceRequestOptions } from "../chat-models.js";
import { isCurrentShort, readGoal, requireGoalShortContent, saveGoal, writeGoalShortContent, type GoalRecord } from "../goal-store.js";
import { buildGoalShortPlan, buildLegacyGoalShortPlan, isLegacyShortDraft, shortStoryboardOf, type GoalShortDraft } from "../goal-short-plan.js";
import { shortWantsPhone, stripShortBannedWords, withoutShortPhoneSentences } from "../goal-short-rules.js";
import { estimateShort } from "../goal-short-runtime.js";
import {
  shortAuthoredCopy, shortBriefPlan, shortPlannerBrief, shortPlannerInstructions, shortPlannerIssues, shortPlannerNeeded, shortPlannerResponseSchema, shortTitle,
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

function cleanedAnswer(answer: ShortPlannerResponse, authored: ShortAuthoredCopy, phones: boolean): ShortPlannerResponse {
  const cleaned = (text: string) => phones ? stripShortBannedWords(text) : withoutShortPhoneSentences(stripShortBannedWords(text));
  return {
    title: stripShortBannedWords(answer.title),
    frame: authored.frame === null ? cleaned(answer.frame) : answer.frame,
    beats: answer.beats.map((beat, index) => authored.beats[index] == null ? cleaned(beat) : beat),
  };
}

async function askShortPlanner(engine: Engine, goal: GoalRecord, brief: string, draft: GoalShortDraft, authored: ShortAuthoredCopy, signal: AbortSignal): Promise<ShortPlannerResponse> {
  const notebook = engine.notebooks.read(goal.notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  const references = isLegacyShortDraft(draft) ? [...draft.character.references, ...draft.extraReferences] : [...draft.sourceImages];
  const storyboard = shortStoryboardOf(draft);
  const count = draft.segmentSeconds.length;
  const options = chatIntelligenceRequestOptions();
  const responses = buildIntelligenceResponses(requireApiKey("OPENAI_API_KEY"), options);
  const fixedBeats = authored.beats.flatMap((beat, index) => beat === null ? [] : [[`beat ${index + 1}`, beat] as const]);
  const phones = shortWantsPhone(brief);
  const request = {
    instructions: await shortPlannerInstructions({
      sourceImageCount: references.length, storyboardFrameCount: storyboard?.frames.length ?? 0, aspectRatio: draft.aspectRatio, segmentSeconds: draft.segmentSeconds,
    }),
    input: [{ role: "user" as const, content: [
      { type: "input_text" as const, text: JSON.stringify({
        brief: shortPlannerBrief(brief, references, notebook.value, storyboard?.video ?? null),
        aspectRatio: draft.aspectRatio,
        segments: draft.segmentSeconds.map((seconds, index) => ({ beat: index + 1, seconds })),
        fixed: Object.fromEntries([...(authored.frame === null ? [] : [["frame", authored.frame] as const]), ...fixedBeats]),
        write: ["title", ...(authored.frame === null ? ["frame"] : []), ...authored.beats.flatMap((beat, index) => beat === null ? [`beat ${index + 1}`] : [])],
      }) },
      ...await goalPlannerImages(engine, references, storyboard?.frames ?? []),
    ] }],
    text: { format: { type: "json_schema" as const, name: "short_plan", strict: true, schema: z.toJSONSchema(shortPlannerResponseSchema(count)) } },
    max_output_tokens: 2000,
  };
  const first = shortPlannerAnswer(firstResponseText(await responses(intelligenceRequest(request, options), signal)));
  const firstIssues: ShortPlannerIssue[] = first
    ? shortPlannerIssues(first, count, authored, phones)
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
  const blocking = shortPlannerIssues(second, count, authored, phones).filter((issue) => issue.kind !== "banned" && issue.kind !== "phone");
  if (blocking.length > 0) throw new Error(`The planner's plan still breaks its limits. ${blocking.map((issue) => issue.message).join(" ")} Try planning again.`);
  const cleaned = cleanedAnswer(second, authored, phones);
  if (shortPlannerIssues({ ...cleaned, title: cleaned.title || "Short" }, count, authored, phones).some((issue) => issue.kind === "empty")) {
    throw new Error("The planner's plan was empty without its banned words or phone sentences. Try planning again.");
  }
  return cleaned;
}

async function planShortGoal(engine: Engine, goalId: string, signal: AbortSignal): Promise<{ goalId: string }> {
  try {
    const goal = readGoal(engine, goalId);
    const content = requireGoalShortContent(engine, goal);
    const { draft } = content;
    if (!draft) throw new Error("This short has nothing to plan. Start a new /goal.");
    const authored = shortAuthoredCopy(content.brief, draft.segmentSeconds);
    const plannedDraft = { ...draft, segmentSeconds: authored.segmentSeconds };
    const written = shortPlannerNeeded(content.brief, plannedDraft.segmentSeconds)
      ? await askShortPlanner(engine, goal, content.brief, plannedDraft, authored, signal)
      : null;
    const offline = written ? null : shortBriefPlan(content.brief, authored);
    const framePrompt = authored.frame ?? written?.frame ?? offline?.frame ?? "";
    const title = written?.title || shortTitle(content.brief, framePrompt);
    const beats = authored.beats.map((beat, index) => beat ?? written?.beats[index] ?? offline?.beats[index] ?? "");
    const plan = isLegacyShortDraft(plannedDraft)
      ? buildLegacyGoalShortPlan({
        title, aspectRatio: plannedDraft.aspectRatio, character: plannedDraft.character,
        framePrompt, beats, segmentSeconds: plannedDraft.segmentSeconds, extraReferences: plannedDraft.extraReferences,
      })
      : buildGoalShortPlan({
        title, aspectRatio: plannedDraft.aspectRatio, sourceImages: plannedDraft.sourceImages, storyboard: shortStoryboardOf(plannedDraft),
        framePrompt, beats, segmentSeconds: plannedDraft.segmentSeconds,
      });
    const estimate = await estimateShort(engine, plan, content);
    const added = [authored.note, offline?.note ?? null].filter((note): note is string => note !== null);
    await withNotebookMutation(`goal:${goalId}`, async () => {
      const current = readGoal(engine, goalId);
      if (current.status !== "planning") return;
      const latest = requireGoalShortContent(engine, current);
      const notes = [...latest.notes];
      for (const note of added) {
        if (!notes.includes(note)) notes.push(note);
      }
      await writeGoalShortContent(engine, current, { ...latest, draft: plannedDraft, plan, estimate, notes, revision: latest.revision + 1 });
      saveGoal(engine, { ...current, stage: shortStoryboardOf(plan) ? "storyboards" : "frame", status: "review", error: null });
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
    return isCurrentShort(goal.planVersion) && goal.status === "planning" ? planShortGoal(engine, goalId, context.signal) : { goalId };
  });
}
