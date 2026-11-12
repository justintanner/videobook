import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine, NotebookDocument } from "videobook-engine";
import { cancelChainRun } from "../chain-executor.js";
import { goalShortPlanSchema } from "../goal-short-plan.js";
import { createShortGoal, priceShortFrame, queueShortRealismCheck, retryShortGoal, selectShortVersion, startShortStage, updateShortGoal } from "../goal-short-runtime.js";
import {
  clearMainCharacterError, describeMainCharacter, reconcileMainCharacter, requireCharacterSheetKey, resolveCharacterReferences,
  saveMainCharacter, startCharacterSheet, type MainCharacterView,
} from "../goal-short-character.js";
import { activeGoalStage, LEGACY_GOAL_MESSAGE, publicGoal, reconcileFinish, reconcileGoal } from "../goal-state.js";
import { findGoalCell, listGoals, readGoal, readGoalCell, saveGoal, type GoalRecord } from "../goal-store.js";
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
const stageSchema = z.enum(["frame", "videos"]);
const feedbackSchema = z.string().trim().min(1).max(300).regex(/^[^@]*$/u, "Use plain text without @ references in revision feedback");
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
  if (goal.planVersion === 4 && goal.finish?.status === "running") {
    if (goal.finish.jobId) await engine.jobs.queue.abort(goal.finish.jobId, "Finishing cancelled");
    return saveGoal(engine, { ...goal, status: "review", error: null, finish: { ...goal.finish, status: "cancelled", error: null } });
  }
  if (!ACTIVE_STATUSES.has(goal.status)) return goal;
  const resumed = options.discard || goal.planVersion !== 4 ? null : stopStillRun(engine, goal);
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
  if (goal.planVersion !== 4 && !LEGACY_ACTIONS.has(String(args.action))) throw new Error(LEGACY_GOAL_MESSAGE);
  if (args.action === "update") return updateShortGoal(engine, goal, args);
  if (args.action === "select") return selectShortVersion(engine, goal, args);
  if (args.action === "approve" || args.action === "regenerate" || args.action === "revise") return startShortStage(engine, goal, args, args.action !== "approve");
  if (args.action === "cancel") return cancelGoal(engine, goal);
  if (args.action === "finish") return queueGoalFinish(engine, goal, args);
  if (args.action === "retry") return retryShortGoal(engine, goal);
  if (args.action === "check") return queueShortRealismCheck(engine, goal, args);
  if (args.action === "dismiss") {
    if (ACTIVE_STATUSES.has(goal.status)) throw new Error("Stop the goal before dismissing it");
    return saveGoal(engine, { ...goal, dismissedAt: new Date().toISOString() });
  }
  return goal;
}

async function mainCharacterAction(engine: Engine, bookId: string, notebookId: string, args: GoalArgs): Promise<MainCharacterView> {
  return withNotebookMutation(`goal-character:${bookId}`, async () => {
    if (args.generate === true) requireCharacterSheetKey();
    let character = await reconcileMainCharacter(engine);
    if (args.name !== undefined || args.description !== undefined || args.reference_ids !== undefined) {
      character = saveMainCharacter(engine, {
        ...(typeof args.name === "string" ? { name: args.name } : {}),
        ...(typeof args.description === "string" ? { description: args.description } : {}),
        ...(Array.isArray(args.reference_ids)
          ? { referenceArtifactIds: resolveCharacterReferences(engine, readNotebook(engine, notebookId), z.array(z.string()).parse(args.reference_ids)) }
          : {}),
      });
    }
    if (args.generate === true) character = await startCharacterSheet(engine, bookId, notebookId);
    for (const goal of character.referenceArtifactIds.length > 0 ? listGoals(engine, notebookId) : []) {
      await withNotebookMutation(`goal:${goal.goalId}`, () => priceShortFrame(engine, readGoal(engine, goal.goalId), character.referenceArtifactIds));
    }
    const view = await describeMainCharacter(engine, readNotebook(engine, notebookId), character);
    clearMainCharacterError(engine, view.sheet.lastError);
    return view;
  });
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
    description: "Run Goal mode on a notebook. create makes a short from a brief: a real-looking phone video, 5 to 60 seconds, starring the book's main character, who never speaks; image cells mentioned in the brief become place or prop references for the opening frame. Then list, status, update, approve, regenerate, select, revise, cancel, retry, finish (cold open plus the saved watermark) or dismiss it by goal_id. Each paid step needs its own approval with its estimate: the GPT Image 2.6 opening frame, the H3 Max base clip, and each H3 Max Extend continuation for the next beat. The character action reads the main character, saves its name, description or reference_ids (image cells), and with generate makes a paid GPT Image 2.6 character sheet. check (stage and index) looks at the selected frame, or 4 frames of a clip's new footage, for AI tells and stores up to 5 findings (note or warn) with that output; it is billed like planning, runs only when asked and never blocks an approval. Goals made by an earlier /goal are read-only: list, status, cancel and dismiss.",
    schema: {
      book_id: z.string().uuid(), notebook_id: z.string().uuid(),
      action: z.enum(["create", "list", "status", "update", "approve", "regenerate", "select", "revise", "cancel", "retry", "dismiss", "finish", "character", "check"]),
      name: goalShortPlanSchema.shape.character.shape.name.optional().describe("character: the main character's name"),
      description: goalShortPlanSchema.shape.character.shape.description.optional().describe("character: what the main character looks like"),
      reference_ids: z.array(z.string().min(1).max(200)).min(1).max(4).optional().describe("character: 1 to 4 grid addresses or artifact ids of image cells that replace the references"),
      generate: z.boolean().optional().describe("character: true makes a paid character sheet that becomes the only reference"),
      start_seconds: z.number().min(0).optional(), end_seconds: z.number().min(0).optional(),
      goal_id: z.string().uuid().optional(), request_id: z.string().min(1).max(200).optional(),
      brief: z.string().trim().min(1).max(6000).optional(), plan: advertisedAs(goalShortPlanSchema, {
        type: "object",
        description: "A short's plan, usually the shortPlan from a video_goal status result with fields edited in place",
      }).optional(),
      revision: z.number().int().nonnegative().optional(),
      stage: stageSchema.optional(), index: z.number().int().min(0).max(15).optional(), artifact_id: z.string().uuid().optional(), feedback: feedbackSchema.optional(),
    },
    handler: async args => {
      try {
        const bookId = engine.book.get().bookId;
        if (args.book_id !== bookId) throw new Error("Goal book does not match the active book");
        const notebookId = String(args.notebook_id);
        const notebook = readNotebook(engine, notebookId);
        if (args.action === "list") return json({ goals: await listGoalSnapshots(engine, notebook) });
        if (args.action === "create") return json(await createGoal(engine, bookId, notebookId, args));
        if (args.action === "character") return json(await mainCharacterAction(engine, bookId, notebookId, args));
        const goalId = z.string().uuid().parse(args.goal_id);
        return await withNotebookMutation(`goal:${goalId}`, async () => json(await goalSnapshot(engine, await applyGoalAction(engine, notebookId, goalId, args))));
      } catch (error) { return failure(error); }
    },
  }];
}
