import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine, NotebookDocument } from "videobook-engine";
import { resolveNotebookCellArtifactId } from "videobook-engine";
import { firstEmptyNotebookGridRow, notebookGridTag, notebookOccupiedSlots, NOTEBOOK_GRID_CAPACITY } from "videobook-engine/notebook-grid";
import { queue } from "../queue.js";
import { cancelChainRun, getChainRun, preflightAndAccept, retryChainRun } from "../chain-executor.js";
import { compileFrameSteps, compileStoryboardSteps, compileVideoSteps, goalBriefConstraints, goalPlanSchema, type GoalGenerationStage, type GoalPlan } from "../goal-plan.js";
import { currentGoalCharacters, resolveGoalCharacters } from "../goal-characters.js";
import { activeGoalStage, completedGoalVideos, LEGACY_GOAL_MESSAGE, publicGoal, reconcileGoal } from "../goal-state.js";
import {
  createGoalCell, emptyGoalEstimates, findGoalCell, goalContent, listGoals, readGoal, readGoalCell, requireGoalContent, saveGoal,
  writeGoalContent, type GoalRecord, type GoalStageOutput,
} from "../goal-store.js";
import { estimateGoal } from "../jobs/plan-goal.js";
import { queueGoalCombination } from "../jobs/combine-goal.js";
import { mutateNotebook, withNotebookMutation } from "../notebook-mutations.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const failure = (error: unknown): ToolResult => ({ isError: true, content: [{ type: "text", text: errorMessage(error) }] });
const ACTIVE_STATUSES = new Set(["planning", "review", "running"]);
type GoalArgs = Record<string, unknown>;
export type GoalSnapshot = ReturnType<typeof publicGoal>;

function readNotebook(engine: Engine, notebookId: string): NotebookDocument {
  const notebook = engine.notebooks.read(notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  return notebook.value;
}

async function goalSnapshot(engine: Engine, goal: GoalRecord): Promise<GoalSnapshot> {
  const current = await reconcileGoal(engine, goal, readNotebook(engine, goal.notebookId));
  return publicGoal(engine, current, readNotebook(engine, goal.notebookId));
}

function requireModernGoal(goal: GoalRecord): void {
  if (goal.planVersion !== 2) throw new Error(LEGACY_GOAL_MESSAGE);
}

function requireRevision(engine: Engine, goal: GoalRecord, revision: unknown): GoalPlan {
  const content = requireGoalContent(engine, goal);
  if (content.revision !== revision) throw new Error("The goal changed. Review the current version before approving it.");
  return goalPlanSchema.parse(content.plan);
}

async function goalToolLookup(engine: Engine) {
  const { getAllToolDefs } = await import("./index.js");
  const defs = getAllToolDefs(engine);
  return { defs, lookup: (name: string) => defs.find(def => def.name === name) };
}

function outputReference(document: NotebookDocument, output: GoalStageOutput | undefined): string {
  const cell = output?.cellId ? document.cells.find(candidate => candidate.id === output.cellId) : null;
  if (!cell || resolveNotebookCellArtifactId(document, cell) !== output?.artifactId) {
    throw new Error("An approved frame changed or was removed. Regenerate it before continuing.");
  }
  return notebookGridTag(cell.slot);
}

async function ensureStageSpace(engine: Engine, goal: GoalRecord, stage: GoalGenerationStage, count: number, plan: GoalPlan): Promise<void> {
  const placed = await mutateNotebook(engine, goal.notebookId, "goal_stage_space", document => {
    const occupied = notebookOccupiedSlots(document.cells);
    const needsTimeline = stage === "videos" && plan.shots.length > 1 && !document.cells.some(cell => cell.type === "timeline");
    if (NOTEBOOK_GRID_CAPACITY - occupied.length < count * 2 + (needsTimeline ? 8 : 0)) {
      throw new Error("The notebook needs two empty cells per stage output and a row for the timeline when combining clips");
    }
    if (!needsTimeline) return document;
    const timeline = engine.notebooks.createCell({ type: "timeline", label: plan.title, slot: firstEmptyNotebookGridRow(occupied) });
    return { ...document, cells: [...document.cells, timeline] };
  });
  if (!placed.ok) throw new Error(placed.error.message);
}

async function startStage(engine: Engine, goal: GoalRecord, args: GoalArgs, regenerate: boolean): Promise<GoalRecord> {
  requireModernGoal(goal);
  const content = requireGoalContent(engine, goal);
  if (!regenerate && goal.status === "running" && goal.stages[activeGoalStage(goal)]?.revision === args.revision) return goal;
  if (goal.status !== "review") throw new Error("Review the goal before approving or regenerating a stage");
  const plan = requireRevision(engine, goal, args.revision);
  if (!process.env.KIE_API_KEY) throw new Error("Set KIE_API_KEY in Settings before generating this stage");
  const stage: GoalGenerationStage = regenerate
    ? goal.stage === "storyboards" ? "frame" : goal.stage === "videos" ? "storyboards" : (() => { throw new Error("There are no stage outputs to regenerate yet"); })()
    : activeGoalStage(goal);
  const indexes = stage === "frame" ? [0]
    : regenerate && Array.isArray(args.shot_indexes) ? [...new Set(z.array(z.number().int().min(0).max(plan.shots.length - 1)).min(1).parse(args.shot_indexes))].sort((a, b) => a - b)
      : plan.shots.map((_, index) => index);
  const document = readNotebook(engine, goal.notebookId);
  const characters = currentGoalCharacters(document, content.characters);
  if (characters.length === 0) throw new Error("This goal has no character images. Start a new /goal.");
  const steps = stage === "frame" ? compileFrameSteps(plan, characters)
    : stage === "storyboards" ? compileStoryboardSteps(plan, characters, outputReference(document, goal.stages.frame?.outputs[0]), indexes)
      : compileVideoSteps(goal.goalId, plan, characters,
        plan.shots.map((_, index) => outputReference(document, goal.stages.storyboards?.outputs.find(output => output.index === index))),
        plan.frameContinuity ? plan.shots.map((_, index) => outputReference(document, goal.stages.storyboards?.outputs.find(output => output.index === index + plan.shots.length))) : []);
  if (stage === "storyboards" && !regenerate) {
    const frameRun = goal.stages.frame;
    const frameStep = frameRun ? getChainRun(engine, frameRun.chainId)?.steps.find(step => step.id === "frame") : null;
    if (frameStep?.params.prompt !== compileFrameSteps(plan, characters)[0]!.params.prompt) {
      throw new Error("The full-frame prompt changed. Regenerate the frame before approving it.");
    }
  }
  if (stage === "videos") {
    const storyboardRun = goal.stages.storyboards;
    const frame = outputReference(document, goal.stages.frame?.outputs[0]);
    for (const expected of compileStoryboardSteps(plan, characters, frame)) {
      const index = Number(expected.id.slice("storyboard".length)) - 1;
      const artifactId = storyboardRun?.outputs.find(output => output.index === index)?.artifactId;
      const source = storyboardRun && [...storyboardRun.previousChainIds, storyboardRun.chainId].flatMap(id => getChainRun(engine, id)?.steps ?? [])
        .find(step => step.id === expected.id && (step.outputs?.asset_id ?? step.outputs?.img_asset_id) === artifactId);
      if (source?.params.prompt !== expected.params.prompt) throw new Error(`${index >= plan.shots.length ? "Ending storyboard" : "Storyboard"} ${index % plan.shots.length + 1} changed. Regenerate it before approving videos.`);
    }
  }
  const track = stage === "videos" && plan.shots.length > 1
    ? engine.sequences.getPrimary().tracks.find(candidate => candidate.kind === "video" && candidate.enabled && !candidate.locked) : null;
  if (stage === "videos" && plan.shots.length > 1 && !track) throw new Error("The sequence needs an enabled, unlocked video track");
  await ensureStageSpace(engine, goal, stage, steps.filter(step => step.id !== "assemble").length, plan);
  const { defs, lookup } = await goalToolLookup(engine);
  const chain = await preflightAndAccept({
    action: "run", version: 1, book_id: goal.bookId, notebook_id: goal.notebookId,
    request_id: `goal:${goal.goalId}:${stage}:${content.revision}${regenerate ? `:regenerate:${indexes.join(",")}` : ""}`, steps,
  }, {
    engine, bookId: goal.bookId, notebookId: goal.notebookId,
    toolSchemas: new Map(defs.map(def => [def.name, def.schema])), autoApplyTools: new Set(),
    effectForTool: name => name === "assemble_goal" ? "mutation" : "generation",
  }, lookup, { actor: "chat" });
  const previous = goal.stages[stage];
  return saveGoal(engine, {
    ...goal, stage, chainId: chain.chainId, status: "running", error: null,
    ...(stage === "videos" ? { clipIds: plan.shots.map(() => uuidv7()), trackId: track?.trackId ?? null } : {}),
    stages: { ...goal.stages, [stage]: {
      chainId: chain.chainId, revision: content.revision, approvedAt: new Date().toISOString(), shotIndexes: indexes,
      outputs: previous?.outputs ?? [], previousChainIds: previous ? [...previous.previousChainIds, previous.chainId] : [],
    } },
  });
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
  return withNotebookMutation(`goal-create:${bookId}`, async () => {
    const brief = z.string().trim().min(1).max(6000).parse(args.brief);
    const requestId = typeof args.request_id === "string" ? args.request_id : uuidv7();
    const existing = listGoals(engine, notebookId).find(goal => goal.requestId === requestId);
    if (existing) {
      const cell = readGoalCell(engine, existing);
      if (cell && goalContent(cell).brief !== brief) throw new Error("This request_id already belongs to a different goal");
      return goalSnapshot(engine, existing);
    }
    goalBriefConstraints(brief);
    const characters = resolveGoalCharacters(engine, readNotebook(engine, notebookId), brief);
    const plan = args.plan === undefined ? null : goalPlanSchema.parse(args.plan);
    const estimate = plan ? await estimateGoal(engine, plan, characters) : emptyGoalEstimates();
    const goalId = uuidv7();
    const cell = await createGoalCell(engine, notebookId, goalId, { brief, characters, revision: plan ? 1 : 0, plan, estimate });
    const timestamp = new Date().toISOString();
    const goal = saveGoal(engine, {
      goalId, bookId, notebookId, cellId: cell.id, requestId, status: plan ? "review" : "planning", planVersion: 2, stage: "frame", stages: {},
      chainId: null, planningJobId: null, clipIds: [], trackId: null, assembly: null, error: null,
      dismissedAt: null, createdAt: timestamp, updatedAt: timestamp,
    });
    return goalSnapshot(engine, plan ? goal : await queuePlanning(engine, goal, `goal-plan-${goalId}`));
  });
}

function validateReviewEdit(goal: GoalRecord, previous: GoalPlan, plan: GoalPlan): void {
  if (goal.stage === "frame") return;
  if (previous.aspectRatio !== plan.aspectRatio || previous.imageModel !== plan.imageModel || previous.imageResolution !== plan.imageResolution
    || previous.continuity !== plan.continuity || previous.shots.length !== plan.shots.length) {
    throw new Error("The characters, visual style, format and shot count are fixed after generating the full frame. Start a new goal to change them.");
  }
  if (previous.frameContinuity !== plan.frameContinuity) throw new Error("Choose ending storyboards before generating the full frame. Start a new goal to change this setting.");
  if (goal.stage === "videos" && previous.frame.prompt !== plan.frame.prompt) {
    throw new Error("Edit the full-frame prompt while reviewing the full frame.");
  }
}

async function updateGoal(engine: Engine, goal: GoalRecord, args: GoalArgs): Promise<GoalRecord> {
  requireModernGoal(goal);
  if (goal.status !== "review") throw new Error("Only a goal awaiting review can be edited");
  const previous = requireRevision(engine, goal, args.revision);
  const content = requireGoalContent(engine, goal);
  const plan = goalPlanSchema.parse(args.plan);
  validateReviewEdit(goal, previous, plan);
  if (JSON.stringify(previous) === JSON.stringify(plan)) return goal;
  const estimate = await estimateGoal(engine, plan, content.characters);
  await writeGoalContent(engine, goal, { ...content, plan, estimate, revision: content.revision + 1 });
  return saveGoal(engine, goal);
}

async function cancelGoal(engine: Engine, goal: GoalRecord): Promise<GoalRecord> {
  if (!ACTIVE_STATUSES.has(goal.status)) return goal;
  const cancelled = saveGoal(engine, { ...goal, status: "cancelled", error: null });
  if (cancelled.chainId) cancelChainRun(engine, cancelled.chainId);
  if (cancelled.planningJobId) await engine.jobs.queue.abort(cancelled.planningJobId, "Goal cancelled");
  return cancelled;
}

async function retryGoal(engine: Engine, goal: GoalRecord): Promise<GoalRecord> {
  requireModernGoal(goal);
  if (goal.status !== "failed" && goal.status !== "interrupted") throw new Error("Only a goal that failed or was interrupted can be retried");
  requireGoalContent(engine, goal);
  if (!goal.chainId) return queuePlanning(engine, goal, `goal-plan-${goal.goalId}-${uuidv7()}`);
  if (!process.env.KIE_API_KEY) throw new Error("Set KIE_API_KEY in Settings before retrying this stage");
  const { lookup } = await goalToolLookup(engine);
  retryChainRun(engine, goal.chainId, lookup);
  return saveGoal(engine, { ...goal, status: "running", error: null });
}

async function applyGoalAction(engine: Engine, notebookId: string, goalId: string, args: GoalArgs): Promise<GoalRecord> {
  const stored = readGoal(engine, goalId);
  if (stored.notebookId !== notebookId) throw new Error("Goal does not belong to this notebook");
  const goal = await reconcileGoal(engine, stored, readNotebook(engine, notebookId));
  if (args.action === "update") return updateGoal(engine, goal, args);
  if (args.action === "approve" || args.action === "regenerate") return startStage(engine, goal, args, args.action === "regenerate");
  if (args.action === "cancel") return cancelGoal(engine, goal);
  if (args.action === "retry") return retryGoal(engine, goal);
  if (args.action === "combine") {
    requireModernGoal(goal);
    return queueGoalCombination(engine, goal);
  }
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
      else await cancelGoal(engine, readGoal(engine, goal.goalId));
    });
  }
  return snapshots;
}

export function goalDefs(engine: Engine): ToolDef[] {
  return [{
    name: "video_goal", scope: "book",
    description: "Create a video goal from character image mentions, review its plan, then approve each paid stage: GPT Image 2.5 full frame, GPT Image 2.5 storyboards, and Seedance 2.5 videos. approve requires the current revision; each stage finishes at the next review. regenerate repeats the full frame or selected zero-based storyboard shot_indexes. Optional plan.frameContinuity (default false) adds one ending storyboard per shot; endingPrompt edits its pose, regeneration replaces the pair, and videos use both first and last frames. update edits a review, cancel stops remaining work, retry resumes the failed stage, and dismiss hides a finished goal. Multiple clips append in order to the sequence; one clip finishes without assembly. combine renders an assembled goal into one video locally, retaining clip audio; repeated calls reuse its output. The plan and character references live in the goal tile; deleting it stops the goal.",
    schema: {
      book_id: z.string().uuid(), notebook_id: z.string().uuid(),
      action: z.enum(["create", "list", "status", "update", "approve", "regenerate", "cancel", "assemble", "retry", "dismiss", "combine"]),
      goal_id: z.string().uuid().optional(), request_id: z.string().min(1).max(200).optional(),
      brief: z.string().trim().min(1).max(6000).optional(), plan: goalPlanSchema.optional(),
      revision: z.number().int().nonnegative().optional(), shot_indexes: z.array(z.number().int().min(0).max(7)).min(1).max(8).optional(),
    },
    handler: async args => {
      try {
        const bookId = engine.book.get().bookId;
        if (args.book_id !== bookId) throw new Error("Goal book does not match the active book");
        const notebookId = String(args.notebook_id);
        const notebook = readNotebook(engine, notebookId);
        if (args.action === "list") return json({ goals: await listGoalSnapshots(engine, notebook) });
        if (args.action === "create") return json(await createGoal(engine, bookId, notebookId, args));
        const goalId = z.string().uuid().parse(args.goal_id);
        if (args.action === "assemble") {
          const goal = readGoal(engine, goalId);
          requireModernGoal(goal);
          if (goal.notebookId !== notebookId) throw new Error("Goal does not belong to this notebook");
          const result = await assembleGoalDef(engine).handler({ book_id: bookId, goal_id: goalId, artifact_ids: completedGoalVideos(engine, goal) });
          if (result.isError) return result;
          return json(await goalSnapshot(engine, readGoal(engine, goalId)));
        }
        return await withNotebookMutation(`goal:${goalId}`, async () => json(await goalSnapshot(engine, await applyGoalAction(engine, notebookId, goalId, args))));
      } catch (error) { return failure(error); }
    },
  }, assembleGoalDef(engine)];
}

function assembleGoalDef(engine: Engine): ToolDef {
  return {
    name: "assemble_goal", scope: "book",
    description: "Append a reviewed goal's completed video-stage clips in order to the sequence. Used by Goal mode for multi-clip plans; single-clip goals need no assembly.",
    schema: { book_id: z.string().uuid(), goal_id: z.string().uuid(), artifact_ids: z.array(z.string().uuid()).min(2).max(8) },
    handler: async args => {
      try {
        const goal = readGoal(engine, String(args.goal_id));
        requireModernGoal(goal);
        if (args.book_id !== goal.bookId || goal.status === "cancelled") throw new Error("Goal is unavailable or cancelled");
        const expected = completedGoalVideos(engine, goal);
        if (expected.length < 2 || expected.length !== goal.clipIds.length || JSON.stringify(expected) !== JSON.stringify(args.artifact_ids)) {
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
