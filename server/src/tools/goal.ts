import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine } from "videobook-engine";
import { firstEmptyNotebookGridRow, notebookOccupiedSlots, NOTEBOOK_GRID_CAPACITY } from "videobook-engine/notebook-grid";
import { queue } from "../queue.js";
import { cancelChainRun, getChainRun, preflightAndAccept } from "../chain-executor.js";
import { compileGoalSteps, goalBriefConstraints, goalPlanSchema, GOAL_VIDEO_TOOL } from "../goal-plan.js";
import { listGoals, readGoal, saveGoal, type GoalRecord } from "../goal-store.js";
import { estimateGoal } from "../jobs/plan-goal.js";
import { mutateNotebook, withNotebookMutation } from "../notebook-mutations.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const failure = (error: unknown): ToolResult => ({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });

function publicGoal(engine: Engine, goal: GoalRecord) {
  const chain = goal.chainId ? getChainRun(engine, goal.chainId) : null;
  const status = goal.status === "cancelled" ? "cancelled" : goal.assembly ? "completed"
    : chain?.status === "accepted" || chain?.status === "awaiting-approval" ? "running"
      : chain?.status ?? goal.status;
  const planningJob = goal.planningJobId ? engine.jobs.queue.get(goal.planningJobId) : null;
  const planningFailed = status === "planning" && planningJob && ["failed", "aborted"].includes(planningJob.state);
  return {
    kind: "video-goal" as const,
    ...goal,
    status: planningFailed ? "failed" : status,
    error: goal.status === "cancelled" ? null : goal.assembly ? null : chain?.error ?? goal.error
      ?? (planningFailed ? planningJob.error?.message ?? "Planning was interrupted" : null),
    steps: chain?.steps.map((step) => ({
      id: step.id, status: step.status, error: step.error,
      artifactId: typeof step.outputs?.asset_id === "string" ? step.outputs.asset_id
        : typeof step.outputs?.vid_asset_id === "string" ? step.outputs.vid_asset_id : null,
    })) ?? [],
  };
}

export type GoalSnapshot = ReturnType<typeof publicGoal>;

async function startGoal(engine: Engine, goal: GoalRecord, revision: unknown): Promise<GoalRecord> {
  if (goal.chainId) return goal;
  if (goal.status !== "review" || !goal.plan) throw new Error("The goal must have a reviewed shot plan before running");
  if (revision !== goal.revision) throw new Error("The shot plan changed. Review the current version before running.");
  if (!process.env.KIE_API_KEY) throw new Error("Set KIE_API_KEY in Settings before running this goal");
  const notebook = engine.notebooks.read(goal.notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  const track = engine.sequences.getPrimary().tracks.find((candidate) => candidate.kind === "video" && candidate.enabled && !candidate.locked);
  if (!track) throw new Error("The sequence needs an enabled, unlocked video track");
  const shotCount = goal.plan.shots.length;
  const placed = await mutateNotebook(engine, goal.notebookId, "goal_timeline", (document) => {
    const occupied = notebookOccupiedSlots(document.cells);
    const hasTimeline = document.cells.some((cell) => cell.type === "timeline");
    if (NOTEBOOK_GRID_CAPACITY - occupied.length < shotCount * 2 + (hasTimeline ? 0 : 8)) {
      throw new Error("The notebook needs two empty cells per shot and a row for the timeline");
    }
    if (hasTimeline) return document;
    const timeline = engine.notebooks.createCell({
      type: "timeline", label: goal.plan!.title, slot: firstEmptyNotebookGridRow(occupied),
    });
    return { ...document, cells: [...document.cells, timeline] };
  });
  if (!placed.ok) throw new Error(placed.error.message);
  const { getAllToolDefs } = await import("./index.js");
  const defs = getAllToolDefs(engine);
  const next = saveGoal(engine, { ...goal, clipIds: goal.plan.shots.map(() => uuidv7()), trackId: track.trackId });
  const chain = await preflightAndAccept({
    action: "run", version: 1, book_id: goal.bookId, notebook_id: goal.notebookId,
    request_id: `goal:${goal.goalId}:${goal.revision}`, steps: compileGoalSteps(goal.goalId, goal.plan),
  }, {
    engine, bookId: goal.bookId, notebookId: goal.notebookId,
    toolSchemas: new Map(defs.map((def) => [def.name, def.schema])), autoApplyTools: new Set(),
    effectForTool: (name) => name === GOAL_VIDEO_TOOL ? "generation" : "mutation",
  }, (name) => defs.find((def) => def.name === name), { actor: "chat" });
  return saveGoal(engine, { ...next, chainId: chain.chainId, status: "running", error: null });
}

export function goalDefs(engine: Engine): ToolDef[] {
  return [{
    name: "video_goal", scope: "book",
    description: "Plan, review and run a multi-shot video goal. create takes a brief and queues planning, or accepts a manually authored plan. Read with list/status, save edits with update, then run the exact reviewed revision. A single run approves all listed clips and appends them in order to the current sequence. cancel stops remaining steps. Planning and results persist in the book.",
    schema: {
      book_id: z.string().uuid(), notebook_id: z.string().uuid(),
      action: z.enum(["create", "list", "status", "update", "run", "cancel", "assemble"]),
      goal_id: z.string().uuid().optional(), request_id: z.string().min(1).max(200).optional(),
      brief: z.string().trim().min(1).max(6000).optional(), plan: goalPlanSchema.optional(),
      revision: z.number().int().nonnegative().optional(),
    },
    handler: async (args) => {
      try {
        const bookId = engine.book.get().bookId;
        if (args.book_id !== bookId) throw new Error("Goal book does not match the active book");
        const notebookId = String(args.notebook_id);
        if (!engine.notebooks.read(notebookId).ok) throw new Error("Notebook not found");
        if (args.action === "list") return json({ goals: listGoals(engine, notebookId).map((goal) => publicGoal(engine, goal)) });
        if (args.action === "create") {
          return await withNotebookMutation(`goal-create:${bookId}`, async () => {
            const brief = z.string().trim().min(1).max(6000).parse(args.brief);
            const requestId = typeof args.request_id === "string" ? args.request_id : uuidv7();
            const existing = listGoals(engine, notebookId).find((goal) => goal.requestId === requestId);
            if (existing) {
              if (existing.brief !== brief) throw new Error("This request_id already belongs to a different goal");
              return json(publicGoal(engine, existing));
            }
            goalBriefConstraints(brief);
            const plan = args.plan === undefined ? null : goalPlanSchema.parse(args.plan);
            const estimate = plan ? await estimateGoal(engine, plan) : { usd: null, warnings: [] };
            const timestamp = new Date().toISOString();
            let goal = saveGoal(engine, {
              goalId: uuidv7(), bookId, notebookId, requestId, brief,
              status: plan ? "review" : "planning", revision: plan ? 1 : 0, plan, estimate,
              chainId: null, planningJobId: null, clipIds: [], trackId: null,
              assembly: null, error: null, createdAt: timestamp, updatedAt: timestamp,
            });
            if (!plan) {
              try {
                const job = await queue.enqueue(`goal-plan-${goal.goalId}`, { type: "plan_goal", bookId, goalId: goal.goalId });
                goal = saveGoal(engine, { ...readGoal(engine, goal.goalId), planningJobId: job.id });
              } catch (error) {
                saveGoal(engine, { ...goal, status: "failed", error: error instanceof Error ? error.message : String(error) });
                throw error;
              }
            }
            return json(publicGoal(engine, goal));
          });
        }
        const goalId = z.string().uuid().parse(args.goal_id);
        if (args.action === "assemble") {
          const goal = readGoal(engine, goalId);
          if (goal.notebookId !== notebookId) throw new Error("Goal does not belong to this notebook");
          const chain = goal.chainId ? getChainRun(engine, goal.chainId) : null;
          const artifactIds = chain?.steps.filter((step) => step.tool === GOAL_VIDEO_TOOL && step.status === "completed")
            .map((step) => step.outputs?.asset_id) ?? [];
          if (!goal.plan || artifactIds.length !== goal.plan.shots.length) throw new Error("Finish every shot before assembling");
          const result = await assembleGoalDef(engine).handler({ book_id: bookId, goal_id: goalId, artifact_ids: artifactIds });
          return result.isError ? result : json(publicGoal(engine, readGoal(engine, goalId)));
        }
        return await withNotebookMutation(`goal:${goalId}`, async () => {
          let goal = readGoal(engine, goalId);
          if (goal.notebookId !== notebookId) throw new Error("Goal does not belong to this notebook");
          if (args.action === "update") {
            if (goal.status !== "review" || goal.chainId) throw new Error("Only a goal awaiting review can be edited");
            if (args.revision !== goal.revision) throw new Error("The goal changed. Reload the current shot plan.");
            const plan = goalPlanSchema.parse(args.plan);
            const estimate = await estimateGoal(engine, plan);
            goal = saveGoal(engine, { ...goal, plan, estimate, revision: goal.revision + 1 });
          } else if (args.action === "run") {
            goal = await startGoal(engine, goal, args.revision);
          } else if (args.action === "cancel") {
            const status = publicGoal(engine, goal).status;
            if (!["completed", "cancelled", "failed", "interrupted"].includes(status)) {
              goal = saveGoal(engine, { ...goal, status: "cancelled" });
              if (goal.chainId) cancelChainRun(engine, goal.chainId);
              if (goal.planningJobId) await engine.jobs.queue.abort(goal.planningJobId, "Goal cancelled");
            }
          }
          return json(publicGoal(engine, goal));
        });
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
        const chain = goal.chainId ? getChainRun(engine, goal.chainId) : null;
        const expected = chain?.steps.filter((step) => step.tool === GOAL_VIDEO_TOOL && step.status === "completed")
          .map((step) => step.outputs?.asset_id);
        if (!expected || expected.length !== goal.plan?.shots.length || JSON.stringify(expected) !== JSON.stringify(args.artifact_ids)) {
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
