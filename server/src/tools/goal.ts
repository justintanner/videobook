import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine, NotebookDocument } from "videobook-engine";
import { cancelChainRun } from "../chain-executor.js";
import { goalShortPlanSchema } from "../goal-short-plan.js";
import { createShortGoal, queueShortRealismCheck, retryShortGoal, selectShortVersion, shortFeedbackSchema, startShortStage, updateShortGoal } from "../goal-short-runtime.js";
import { LEGACY_GOAL_MESSAGE, publicGoal, reconcileFinish, reconcileGoal } from "../goal-state.js";
import { activeGoalStage, findGoalCell, isCurrentShort, listGoals, readGoal, readGoalCell, saveGoal, type GoalRecord } from "../goal-store.js";
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
const stageSchema = z.enum(["storyboards", "frame", "videos"]);
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
    description: "Run Goal mode on a notebook. create makes a short from a brief: a real-looking phone video, 5 to 60 seconds, starring the person in the images the brief mentions, or the person the brief describes when it mentions none; that person never speaks. Every image the brief mentions is a source image, kept as photographed, up to 12. The first video the brief mentions becomes the short's storyboard: 4 frames (one per shot when it has cuts, from its \"at Ns\" when given) captured into image cells at no cost, which the planner follows in order; further videos and unusable mentions are skipped with a note. Lengths are clamped to 5-60 seconds, extra quoted beats are fitted or folded into the last beat, and without OPENAI_API_KEY the brief supplies a reviewable plan. Then list, status, update, approve, regenerate, select, revise, cancel, retry, finish (the reviewed take plus the saved watermark) or dismiss it by goal_id. approve runs the stage under review, and naming another stage is refused. regenerate, select and revise take a stage (storyboards, frame or videos) and index. revise (stage, index, feedback up to 2000 characters) rewrites an @ mention to the cell's label, then has OpenAI rewrite that storyboard frame's clean-up prompt, the frame prompt or the beat with the feedback, billed like planning, replacing any sentence the feedback contradicts, and saves it in the plan before the paid regeneration. Each paid step needs its own approval with its estimate: the storyboard clean-up (one Nano Banana 2.1 edit per frame that removes captions, stickers, logos, credits and shade), the GPT Image 2.6 opening frame (from the source images and clean storyboard frame 1, which it cannot start without), the H3 Max base clip, and each H3 Max Extend continuation for the next beat. check (frame or videos, and index) looks at the selected frame, or 4 frames of a clip's new footage, for AI tells and stores up to 5 findings (note or warn) with that output; it is billed like planning, runs only when asked and never blocks an approval. Goals made by an earlier /goal are read-only: list, status, cancel and dismiss.",
    schema: {
      book_id: z.string().uuid(), notebook_id: z.string().uuid(),
      action: z.enum(["create", "list", "status", "update", "approve", "regenerate", "select", "revise", "cancel", "retry", "dismiss", "finish", "check"]),
      goal_id: z.string().uuid().optional(), request_id: z.string().min(1).max(200).optional(),
      brief: z.string().trim().min(1).max(6000).optional(), plan: advertisedAs(goalShortPlanSchema, {
        type: "object",
        description: "A short's plan, usually the shortPlan from a video_goal status result with fields edited in place",
      }).optional(),
      revision: z.number().int().nonnegative().optional(),
      stage: stageSchema.optional(), index: z.number().int().min(0).max(15).optional(), artifact_id: z.string().uuid().optional(),
      feedback: shortFeedbackSchema.optional().describe("revise: what to change, written into the frame prompt or the beat before the paid step. An @ mention is rewritten to the cell's label"),
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
        return await withNotebookMutation(`goal:${goalId}`, async () => json(await goalSnapshot(engine, await applyGoalAction(engine, notebookId, goalId, args))));
      } catch (error) { return failure(error); }
    },
  }];
}
