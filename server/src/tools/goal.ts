import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { notebookGridTag } from "videobook-engine";
import { firstEmptyNotebookGridRow, notebookOccupiedSlots, NOTEBOOK_GRID_CAPACITY } from "videobook-engine/notebook-grid";
import { queue } from "../queue.js";
import { cancelChainRun, getChainRun, preflightAndAccept, retryChainRun, type ChainRunRecord } from "../chain-executor.js";
import { compileGoalSteps, goalBriefConstraints, goalPlanSchema, GOAL_VIDEO_TOOL, type GoalPlan } from "../goal-plan.js";
import {
  createGoalCell, findGoalCell, goalContent, listGoals, readGoal, readGoalCell, requireGoalContent, saveGoal,
  writeGoalContent, type GoalContent, type GoalRecord, type GoalStatus,
} from "../goal-store.js";
import { estimateGoal } from "../jobs/plan-goal.js";
import { mutateNotebook, withNotebookMutation } from "../notebook-mutations.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const failure = (error: unknown): ToolResult => ({ isError: true, content: [{ type: "text", text: errorMessage(error) }] });

const EMPTY_CONTENT: GoalContent = { brief: "", revision: 0, plan: null, estimate: { usd: null, warnings: [] } };
const ACTIVE_STATUSES = new Set<GoalStatus>(["planning", "review", "running"]);
const CHAIN_FINAL_STATUSES = new Set<GoalStatus>(["completed", "failed", "cancelled", "interrupted"]);

type GoalArgs = Record<string, unknown>;

function stringOutput(outputs: Record<string, unknown> | null, key: string): string | null {
  const value = outputs?.[key];
  return typeof value === "string" ? value : null;
}

function goalState(engine: Engine, goal: GoalRecord): { status: GoalStatus; error: string | null; chain: ChainRunRecord | null } {
  const chain = goal.chainId ? getChainRun(engine, goal.chainId) : null;
  const planningJob = goal.planningJobId ? engine.jobs.queue.get(goal.planningJobId) : null;
  const planningFailed = goal.status === "planning" && Boolean(planningJob && ["failed", "aborted"].includes(planningJob.state));
  const chainStatus = chain?.status;
  const status: GoalStatus = goal.status === "cancelled" ? "cancelled"
    : goal.assembly ? "completed"
      : planningFailed ? "failed"
        : chainStatus === "accepted" || chainStatus === "awaiting-approval" || chainStatus === "running" ? "running"
          : chainStatus && CHAIN_FINAL_STATUSES.has(chainStatus) ? chainStatus
            : goal.status;
  const error = status === "cancelled" || goal.assembly ? null
    : chain?.error ?? goal.error ?? (planningFailed ? planningJob?.error?.message ?? "Planning was interrupted" : null);
  return { status, error, chain };
}

function goalProducerCells(document: NotebookDocument | null, chainId: string | null): Map<string, NotebookCell> {
  const producers = new Map<string, NotebookCell>();
  if (!document || !chainId) return producers;
  for (const cell of document.cells) {
    const runId = cell.inputs?.chainRunId;
    if (typeof runId !== "string" || !runId.startsWith(`${chainId}:`)) continue;
    const stepId = runId.slice(chainId.length + 1);
    const current = producers.get(stepId);
    if (!current || current.id < cell.id) producers.set(stepId, cell);
  }
  return producers;
}

function stepProducer(
  document: NotebookDocument | null,
  producers: Map<string, NotebookCell>,
  step: ChainRunRecord["steps"][number],
): NotebookCell | null {
  const tagged = producers.get(step.id);
  if (tagged) return tagged;
  const outputCellId = stringOutput(step.outputs, "cell_id");
  if (!document || !outputCellId) return null;
  const edge = document.edges.find((candidate) => candidate.target === outputCellId);
  return document.cells.find((cell) => cell.id === edge?.source) ?? null;
}

function publicGoal(engine: Engine, goal: GoalRecord, document: NotebookDocument | null) {
  const cell = document ? findGoalCell(document, goal) : null;
  const content = cell ? goalContent(cell) : EMPTY_CONTENT;
  const { status, error, chain } = goalState(engine, goal);
  const producers = goalProducerCells(document, goal.chainId);
  return {
    kind: "video-goal" as const,
    goalId: goal.goalId,
    bookId: goal.bookId,
    notebookId: goal.notebookId,
    cellId: goal.cellId,
    address: cell ? notebookGridTag(cell.slot) : null,
    requestId: goal.requestId,
    brief: content.brief,
    revision: content.revision,
    plan: content.plan,
    estimate: content.estimate,
    status,
    error,
    chainId: goal.chainId,
    planningJobId: goal.planningJobId,
    clipIds: goal.clipIds,
    trackId: goal.trackId,
    assembly: goal.assembly,
    dismissedAt: goal.dismissedAt ?? null,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    steps: chain?.steps.map((step) => {
      const producer = stepProducer(document, producers, step);
      return {
        id: step.id,
        status: step.status,
        error: step.error,
        artifactId: stringOutput(step.outputs, "asset_id") ?? stringOutput(step.outputs, "vid_asset_id"),
        cellId: producer?.id ?? null,
        address: producer ? notebookGridTag(producer.slot) : stringOutput(step.outputs, "address"),
        outputCellId: stringOutput(step.outputs, "cell_id"),
        startedAt: step.startedAt ?? null,
      };
    }) ?? [],
  };
}

export type GoalSnapshot = ReturnType<typeof publicGoal>;

function readNotebook(engine: Engine, notebookId: string): NotebookDocument {
  const notebook = engine.notebooks.read(notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  return notebook.value;
}

function goalSnapshot(engine: Engine, goal: GoalRecord): GoalSnapshot {
  return publicGoal(engine, goal, readNotebook(engine, goal.notebookId));
}

function requireVideoKey(): void {
  if (!process.env.KIE_API_KEY) throw new Error("Set KIE_API_KEY in Settings before running this goal");
}

async function goalToolLookup(engine: Engine) {
  const { getAllToolDefs } = await import("./index.js");
  const defs = getAllToolDefs(engine);
  return { defs, lookup: (name: string) => defs.find((def) => def.name === name) };
}

function completedShotAssets(chain: ChainRunRecord | null): unknown[] {
  return chain?.steps.filter((step) => step.tool === GOAL_VIDEO_TOOL && step.status === "completed")
    .map((step) => step.outputs?.asset_id) ?? [];
}

async function ensureGoalSpace(engine: Engine, notebookId: string, plan: GoalPlan): Promise<void> {
  const placed = await mutateNotebook(engine, notebookId, "goal_timeline", (document) => {
    const occupied = notebookOccupiedSlots(document.cells);
    const hasTimeline = document.cells.some((cell) => cell.type === "timeline");
    if (NOTEBOOK_GRID_CAPACITY - occupied.length < plan.shots.length * 2 + (hasTimeline ? 0 : 8)) {
      throw new Error("The notebook needs two empty cells per shot and a row for the timeline");
    }
    if (hasTimeline) return document;
    const timeline = engine.notebooks.createCell({ type: "timeline", label: plan.title, slot: firstEmptyNotebookGridRow(occupied) });
    return { ...document, cells: [...document.cells, timeline] };
  });
  if (!placed.ok) throw new Error(placed.error.message);
}

async function startGoal(engine: Engine, goal: GoalRecord, revision: unknown): Promise<GoalRecord> {
  if (goal.chainId) return goal;
  const content = requireGoalContent(engine, goal);
  const plan = content.plan;
  if (goal.status !== "review" || !plan) throw new Error("The goal must have a reviewed shot plan before running");
  if (revision !== content.revision) throw new Error("The shot plan changed. Review the current version before running.");
  requireVideoKey();
  const track = engine.sequences.getPrimary().tracks.find((candidate) => candidate.kind === "video" && candidate.enabled && !candidate.locked);
  if (!track) throw new Error("The sequence needs an enabled, unlocked video track");
  await ensureGoalSpace(engine, goal.notebookId, plan);
  const { defs, lookup } = await goalToolLookup(engine);
  const next = saveGoal(engine, { ...goal, clipIds: plan.shots.map(() => uuidv7()), trackId: track.trackId });
  const chain = await preflightAndAccept({
    action: "run", version: 1, book_id: goal.bookId, notebook_id: goal.notebookId,
    request_id: `goal:${goal.goalId}:${content.revision}`, steps: compileGoalSteps(goal.goalId, plan),
  }, {
    engine, bookId: goal.bookId, notebookId: goal.notebookId,
    toolSchemas: new Map(defs.map((def) => [def.name, def.schema])), autoApplyTools: new Set(),
    effectForTool: (name) => name === GOAL_VIDEO_TOOL ? "generation" : "mutation",
  }, lookup, { actor: "chat" });
  return saveGoal(engine, { ...next, chainId: chain.chainId, status: "running", error: null });
}

async function queuePlanning(engine: Engine, goal: GoalRecord, operationId: string): Promise<GoalRecord> {
  const planning = saveGoal(engine, { ...goal, status: "planning", error: null });
  try {
    const job = await queue.enqueue(operationId, { type: "plan_goal", bookId: goal.bookId, goalId: goal.goalId });
    return saveGoal(engine, { ...readGoal(engine, goal.goalId), planningJobId: job.id });
  } catch (error) {
    saveGoal(engine, { ...planning, status: "failed", error: errorMessage(error) });
    throw error;
  }
}

async function createGoal(engine: Engine, bookId: string, notebookId: string, args: GoalArgs): Promise<GoalSnapshot> {
  return await withNotebookMutation(`goal-create:${bookId}`, async () => {
    const brief = z.string().trim().min(1).max(6000).parse(args.brief);
    const requestId = typeof args.request_id === "string" ? args.request_id : uuidv7();
    const existing = listGoals(engine, notebookId).find((goal) => goal.requestId === requestId);
    if (existing) {
      const cell = readGoalCell(engine, existing);
      if (cell && goalContent(cell).brief !== brief) throw new Error("This request_id already belongs to a different goal");
      return goalSnapshot(engine, existing);
    }
    goalBriefConstraints(brief);
    const plan = args.plan === undefined ? null : goalPlanSchema.parse(args.plan);
    const estimate = plan ? await estimateGoal(engine, plan) : { usd: null, warnings: [] };
    const goalId = uuidv7();
    const cell = await createGoalCell(engine, notebookId, goalId, { brief, revision: plan ? 1 : 0, plan, estimate });
    const timestamp = new Date().toISOString();
    const goal = saveGoal(engine, {
      goalId, bookId, notebookId, cellId: cell.id, requestId, status: plan ? "review" : "planning",
      chainId: null, planningJobId: null, clipIds: [], trackId: null, assembly: null, error: null,
      dismissedAt: null, createdAt: timestamp, updatedAt: timestamp,
    });
    const queued = plan ? goal : await queuePlanning(engine, goal, `goal-plan-${goalId}`);
    return goalSnapshot(engine, queued);
  });
}

async function updateGoal(engine: Engine, goal: GoalRecord, args: GoalArgs): Promise<GoalRecord> {
  if (goal.status !== "review" || goal.chainId) throw new Error("Only a goal awaiting review can be edited");
  const content = requireGoalContent(engine, goal);
  if (args.revision !== content.revision) throw new Error("The goal changed. Reload the current shot plan.");
  const plan = goalPlanSchema.parse(args.plan);
  const estimate = await estimateGoal(engine, plan);
  await writeGoalContent(engine, goal, { ...content, plan, estimate, revision: content.revision + 1 });
  return saveGoal(engine, goal);
}

async function cancelGoal(engine: Engine, goal: GoalRecord): Promise<GoalRecord> {
  if (!ACTIVE_STATUSES.has(goalState(engine, goal).status)) return goal;
  const cancelled = saveGoal(engine, { ...goal, status: "cancelled" });
  if (cancelled.chainId) cancelChainRun(engine, cancelled.chainId);
  if (cancelled.planningJobId) await engine.jobs.queue.abort(cancelled.planningJobId, "Goal cancelled");
  return cancelled;
}

async function retryGoal(engine: Engine, goal: GoalRecord): Promise<GoalRecord> {
  const status = goalState(engine, goal).status;
  if (status !== "failed" && status !== "interrupted") throw new Error("Only a goal that failed or was interrupted can be retried");
  requireGoalContent(engine, goal);
  if (!goal.chainId) return await queuePlanning(engine, goal, `goal-plan-${goal.goalId}-${uuidv7()}`);
  requireVideoKey();
  const { lookup } = await goalToolLookup(engine);
  retryChainRun(engine, goal.chainId, lookup);
  return saveGoal(engine, { ...goal, status: "running", error: null });
}

function dismissGoal(engine: Engine, goal: GoalRecord): GoalRecord {
  if (ACTIVE_STATUSES.has(goalState(engine, goal).status)) throw new Error("Stop the goal before dismissing it");
  return saveGoal(engine, { ...goal, dismissedAt: new Date().toISOString() });
}

async function applyGoalAction(engine: Engine, notebookId: string, goalId: string, args: GoalArgs): Promise<GoalRecord> {
  const goal = readGoal(engine, goalId);
  if (goal.notebookId !== notebookId) throw new Error("Goal does not belong to this notebook");
  if (args.action === "update") return await updateGoal(engine, goal, args);
  if (args.action === "run") return await startGoal(engine, goal, args.revision);
  if (args.action === "cancel") return await cancelGoal(engine, goal);
  if (args.action === "retry") return await retryGoal(engine, goal);
  if (args.action === "dismiss") return dismissGoal(engine, goal);
  return goal;
}

async function stopRemovedGoal(engine: Engine, goal: GoalRecord): Promise<void> {
  if (!ACTIVE_STATUSES.has(goal.status) || goal.assembly) return;
  await withNotebookMutation(`goal:${goal.goalId}`, async () => {
    await cancelGoal(engine, readGoal(engine, goal.goalId));
  });
}

async function listGoalSnapshots(engine: Engine, notebook: NotebookDocument): Promise<GoalSnapshot[]> {
  const snapshots: GoalSnapshot[] = [];
  for (const goal of listGoals(engine, notebook.id)) {
    if (findGoalCell(notebook, goal)) snapshots.push(publicGoal(engine, goal, notebook));
    else await stopRemovedGoal(engine, goal);
  }
  return snapshots;
}

async function assembleGoal(engine: Engine, notebookId: string, goalId: string): Promise<ToolResult> {
  const goal = readGoal(engine, goalId);
  if (goal.notebookId !== notebookId) throw new Error("Goal does not belong to this notebook");
  const artifactIds = completedShotAssets(goal.chainId ? getChainRun(engine, goal.chainId) : null);
  if (artifactIds.length === 0 || artifactIds.length !== goal.clipIds.length) throw new Error("Finish every shot before assembling");
  const result = await assembleGoalDef(engine).handler({ book_id: goal.bookId, goal_id: goalId, artifact_ids: artifactIds });
  if (result.isError) return result;
  return json(goalSnapshot(engine, readGoal(engine, goalId)));
}

export function goalDefs(engine: Engine): ToolDef[] {
  return [{
    name: "video_goal", scope: "book",
    description: "Plan, review and run a multi-shot video goal saved in a goal tile on the notebook grid. create takes a brief, places the tile and queues planning, or accepts a manually authored plan. Read with list/status, save edits with update, then run the exact reviewed revision. A single run approves all listed clips and appends them in order to the current sequence. cancel stops remaining steps, retry resumes a failed or interrupted goal from its first unfinished part, and dismiss hides a finished goal from the chat input. The plan persists in its tile; deleting the tile stops the goal.",
    schema: {
      book_id: z.string().uuid(), notebook_id: z.string().uuid(),
      action: z.enum(["create", "list", "status", "update", "run", "cancel", "assemble", "retry", "dismiss"]),
      goal_id: z.string().uuid().optional(), request_id: z.string().min(1).max(200).optional(),
      brief: z.string().trim().min(1).max(6000).optional(), plan: goalPlanSchema.optional(),
      revision: z.number().int().nonnegative().optional(),
    },
    handler: async (args) => {
      try {
        const bookId = engine.book.get().bookId;
        if (args.book_id !== bookId) throw new Error("Goal book does not match the active book");
        const notebookId = String(args.notebook_id);
        const notebook = engine.notebooks.read(notebookId);
        if (!notebook.ok) throw new Error("Notebook not found");
        if (args.action === "list") return json({ goals: await listGoalSnapshots(engine, notebook.value) });
        if (args.action === "create") return json(await createGoal(engine, bookId, notebookId, args));
        const goalId = z.string().uuid().parse(args.goal_id);
        if (args.action === "assemble") return await assembleGoal(engine, notebookId, goalId);
        const goal = await withNotebookMutation(`goal:${goalId}`, () => applyGoalAction(engine, notebookId, goalId, args));
        return json(goalSnapshot(engine, goal));
      } catch (error) { return failure(error); }
    },
  }, assembleGoalDef(engine)];
}

function assembleGoalDef(engine: Engine): ToolDef {
  return {
    name: "assemble_goal", scope: "book",
    description: "Complete a reviewed video goal by appending its finished shots to the sequence. Used by Goal mode; all clips must match the goal's completed generation steps.",
    schema: { book_id: z.string().uuid(), goal_id: z.string().uuid(), artifact_ids: z.array(z.string().uuid()).min(1).max(8) },
    handler: async (args) => {
      try {
        const goal = readGoal(engine, String(args.goal_id));
        if (args.book_id !== goal.bookId || goal.status === "cancelled") throw new Error("Goal is unavailable or cancelled");
        const expected = completedShotAssets(goal.chainId ? getChainRun(engine, goal.chainId) : null);
        if (expected.length === 0 || expected.length !== goal.clipIds.length || JSON.stringify(expected) !== JSON.stringify(args.artifact_ids)) {
          throw new Error("Only this goal's completed shots can be assembled");
        }
        const result = await queue.enqueueAndWait(`goal-assemble-${goal.goalId}-${uuidv7()}`, {
          type: "assemble_goal", bookId: goal.bookId, goalId: goal.goalId, artifactIds: expected,
        });
        return json(result);
      } catch (error) { return failure(error); }
    },
  };
}
