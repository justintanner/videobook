import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine, NotebookDocument } from "videobook-engine";
import { cancelChainRun } from "../chain-executor.js";
import { goalShortPlanSchema, SHORT_STORYBOARD_MODELS, shortPlanTitleInput } from "../goal-short-plan.js";
import { createShortGoal, queueShortRealismCheck, reanalyzeShortGoal, retryShortGoal, saveShortDefaults, selectShortVersion, shortFeedbackSchema, startShortStage, updateShortGoal } from "../goal-short-runtime.js";
import { LEGACY_GOAL_MESSAGE, publicGoal, reconcileFinish, reconcileGoal } from "../goal-state.js";
import { activeGoalStage, findGoalCell, isCurrentShort, listGoals, readGoal, readGoalCell, saveGoal, type GoalRecord } from "../goal-store.js";
import { requestGoalTitles, type GoalTitleOptions } from "../graphics/suggest.js";
import { queueGoalFinish } from "../jobs/finish-goal.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { advertisedAs } from "./tool-json-schema.js";

const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const failure = (error: unknown): ToolResult => ({ isError: true, content: [{ type: "text", text: errorMessage(error) }] });
const ACTIVE_STATUSES = new Set(["planning", "review", "running"]);
const LEGACY_ACTIONS = new Set(["status", "cancel", "dismiss"]);
type GoalArgs = Record<string, unknown>;
const stageSchema = z.enum(["storyboards", "replacement", "frame", "videos"]);
export type GoalSnapshot = Awaited<ReturnType<typeof publicGoal>>;
export type ShortGoalSnapshot = Extract<GoalSnapshot, { legacy: false }>;
export type LegacyGoalSnapshot = Extract<GoalSnapshot, { legacy: true }>;

function readNotebook(engine: Engine, notebookId: string): NotebookDocument {
  const notebook = engine.notebooks.read(notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  return notebook.value;
}

async function goalSnapshot(engine: Engine, goal: GoalRecord): Promise<GoalSnapshot> {
  const finished = reconcileFinish(engine, goal);
  const current = await reconcileGoal(engine, finished, readNotebook(engine, finished.notebookId));
  return publicGoal(engine, current, readNotebook(engine, finished.notebookId));
}

async function createGoal(engine: Engine, bookId: string, notebookId: string, args: GoalArgs): Promise<GoalSnapshot> {
  return withNotebookMutation(`goal-create:${bookId}`, async () => {
    const brief = z.string().trim().min(1).max(6000).parse(args.brief);
    const requestId = typeof args.request_id === "string" ? args.request_id : uuidv7();
    const existing = listGoals(engine, notebookId).find(goal => goal.requestId === requestId);
    if (existing) {
      const cell = readGoalCell(engine, existing);
      if (cell && (cell.prompt ?? "") !== brief) throw new Error("This request_id already belongs to a different goal");
      return goalSnapshot(engine, existing);
    }
    const plan = args.plan === undefined ? undefined : goalShortPlanSchema.parse(args.plan);
    return goalSnapshot(engine, await createShortGoal(engine, bookId, notebookId, { brief, requestId, ...(plan ? { plan } : {}) }));
  });
}

function stopStillRun(engine: Engine, goal: GoalRecord): GoalRecord | null {
  const stage = activeGoalStage(goal);
  const run = goal.stages[stage];
  const previousChainId = run?.previousChainIds.at(-1);
  if (goal.status !== "running" || !goal.resumeStage || !run || !previousChainId || !goal.chainId) return null;
  cancelChainRun(engine, goal.chainId);
  const finish = goal.resumeFinish === undefined ? goal.finish : goal.resumeFinish;
  return saveGoal(engine, {
    ...goal, status: goal.resumeStatus ?? "review", stage: goal.resumeStage, chainId: previousChainId, error: null, resumeStage: null, resumeStatus: null, resumeOutputs: null,
    ...(goal.resumeFinish !== undefined ? { resumeFinish: null, finish } : {}),
    stages: { ...goal.stages, [stage]: {
      ...run, outputs: goal.resumeOutputs ?? run.outputs, chainId: previousChainId, previousChainIds: [...run.previousChainIds.slice(0, -1), run.chainId],
    } },
  });
}

async function cancelGoal(engine: Engine, goal: GoalRecord, options: { discard?: boolean } = {}): Promise<GoalRecord> {
  if (isCurrentShort(goal.planVersion) && goal.finish?.status === "running") {
    if (goal.finish.jobId) await engine.jobs.queue.abort(goal.finish.jobId, "Finishing cancelled");
    return saveGoal(engine, { ...goal, status: "review", error: null, finish: { ...goal.finish, status: "cancelled", error: null } });
  }
  if (!ACTIVE_STATUSES.has(goal.status)) return goal;
  const resumed = options.discard || !isCurrentShort(goal.planVersion) ? null : stopStillRun(engine, goal);
  if (resumed) return resumed;
  const cancelled = saveGoal(engine, { ...goal, status: "cancelled", error: null });
  if (cancelled.chainId) cancelChainRun(engine, cancelled.chainId);
  if (cancelled.planningJobId) await engine.jobs.queue.abort(cancelled.planningJobId, "Goal cancelled");
  return cancelled;
}

async function applyGoalAction(engine: Engine, notebookId: string, goalId: string, args: GoalArgs): Promise<GoalRecord> {
  const stored = readGoal(engine, goalId);
  if (stored.notebookId !== notebookId) throw new Error("Goal does not belong to this notebook");
  const goal = await reconcileGoal(engine, stored, readNotebook(engine, notebookId));
  if (!isCurrentShort(goal.planVersion) && !LEGACY_ACTIONS.has(String(args.action))) throw new Error(LEGACY_GOAL_MESSAGE);
  if (args.action === "update") return updateShortGoal(engine, goal, args);
  if (args.action === "analyze") return reanalyzeShortGoal(engine, goal, args.revision);
  if (args.action === "save_defaults") return saveShortDefaults(engine, goal, args.revision);
  if (args.action === "select") return selectShortVersion(engine, goal, args);
  if (args.action === "approve" || args.action === "regenerate" || args.action === "revise") return startShortStage(engine, goal, args, args.action !== "approve");
  if (args.action === "cancel") return cancelGoal(engine, goal);
  if (args.action === "finish") return queueGoalFinish(engine, goal);
  if (args.action === "retry") return retryShortGoal(engine, goal);
  if (args.action === "check") return queueShortRealismCheck(engine, goal, args);
  if (args.action === "dismiss") {
    if (ACTIVE_STATUSES.has(goal.status)) throw new Error("Stop the goal before dismissing it");
    return saveGoal(engine, { ...goal, dismissedAt: new Date().toISOString() });
  }
  return goal;
}

async function writeGoalTitles(engine: Engine, bookId: string, notebookId: string, goalId: string): Promise<GoalTitleOptions> {
  if (readGoal(engine, goalId).notebookId !== notebookId) throw new Error("Goal does not belong to this notebook");
  try {
    return await requestGoalTitles(engine, bookId, goalId);
  } catch (error) {
    const message = errorMessage(error);
    if (/^Job \d+ timed out/u.test(message)) throw new Error("Writing the title took too long. Write title again, or type the title.");
    throw new Error(message.replace(/^Job \d+ (?:failed|aborted): /u, ""));
  }
}

async function listGoalSnapshots(engine: Engine, notebook: NotebookDocument): Promise<GoalSnapshot[]> {
  const snapshots: GoalSnapshot[] = [];
  for (const goal of listGoals(engine, notebook.id)) {
    await withNotebookMutation(`goal:${goal.goalId}`, async () => {
      if (findGoalCell(notebook, goal)) snapshots.push(await goalSnapshot(engine, readGoal(engine, goal.goalId)));
      else await cancelGoal(engine, readGoal(engine, goal.goalId), { discard: true });
    });
  }
  return snapshots;
}

export function goalDefs(engine: Engine): ToolDef[] {
  return [{
    name: "video_goal", scope: "book",
    description: "Run Goal mode on a notebook. create makes a 5-60 second short (12 by default). Mention images for identity and the first video as the source. Initial queued analysis reuses current source metadata, scenes and sampled observations, resolves the brief against book defaults, chooses an action-relevant source frame, and records timing, reference requirements, graphics removal, sound, branding, costs and unresolved decisions before generation. An explicit @a1 at 3s pins the source frame. The editable shortPlan.analysis contains the resolved recipe; explicit instructions override defaults. Source remixes can insert or replace a person and preserve source shots. Authored replace/frame/video or numbered beat prompts skip paid prompt writing but still receive initial preflight. analyze refreshes source evidence using caches and retains authored prompts; save_defaults explicitly saves the current effective choices for future goals in this book. update saves edited prompts, analysis choices or finish.title. Each paid stage remains reviewable: approve, regenerate, select or revise by stage/index. revise rewrites the prompt from feedback before generation. Replacement and action references use GPT Image 2.6; video uses H3 Max, with Extend for subsequent beats. Saved storyboard plans keep their existing cleanup workflow. check assesses the selected frame/video for AI tells, billed like planning. title returns three optional burned-title choices without saving them. finish renders the saved watermark/title on the selected take. list, status, cancel, retry and dismiss manage existing goals. Saved v4/v5 goals retain their stored settings until explicitly edited or reanalyzed; earlier legacy goals are read-only.",
    schema: {
      book_id: z.string().uuid(), notebook_id: z.string().uuid(),
      action: z.enum(["create", "list", "status", "update", "analyze", "save_defaults", "approve", "regenerate", "select", "revise", "cancel", "retry", "dismiss", "finish", "check", "title"]),
      goal_id: z.string().uuid().optional(), request_id: z.string().min(1).max(200).optional(),
      brief: z.string().trim().min(1).max(6000).optional(), plan: advertisedAs(z.preprocess(shortPlanTitleInput, goalShortPlanSchema), {
        type: "object",
        description: "A short's plan, usually the shortPlan from a video_goal status result with fields edited in place",
      }).optional(),
      revision: z.number().int().nonnegative().optional(),
      stage: stageSchema.optional(), index: z.number().int().min(0).max(15).optional(), artifact_id: z.string().uuid().optional(),
      feedback: shortFeedbackSchema.optional().describe("revise: what to change, written into the frame prompt or the beat before the paid step. An @ mention is rewritten to the cell's label"),
      model: z.enum(SHORT_STORYBOARD_MODELS).optional().describe("regenerate or revise one storyboard frame: the clean-up model, the storyboard's own or its other one (Seedream 5.5 Edit on Kie or Nano Banana 2.1 Edit on fal); omitted uses the storyboard's own"),
    },
    handler: async args => {
      try {
        const bookId = engine.book.get().bookId;
        if (args.book_id !== bookId) throw new Error("Goal book does not match the active book");
        const notebookId = String(args.notebook_id);
        const notebook = readNotebook(engine, notebookId);
        if (args.action === "list") return json({ goals: await listGoalSnapshots(engine, notebook) });
        if (args.action === "create") return json(await createGoal(engine, bookId, notebookId, args));
        if (args.action === "character") throw new Error("Unknown action: character");
        const goalId = z.string().uuid().parse(args.goal_id);
        if (args.action === "title") return json(await writeGoalTitles(engine, bookId, notebookId, goalId));
        return await withNotebookMutation(`goal:${goalId}`, async () => json(await goalSnapshot(engine, await applyGoalAction(engine, notebookId, goalId, args))));
      } catch (error) { return failure(error); }
    },
  }];
}
