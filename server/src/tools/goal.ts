import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine, NotebookDocument } from "videobook-engine";
import { resolveNotebookCellArtifactId } from "videobook-engine";
import { firstEmptyNotebookGridRow, notebookGridTag, notebookOccupiedSlots, NOTEBOOK_GRID_CAPACITY } from "videobook-engine/notebook-grid";
import { queue } from "../queue.js";
import { cancelChainRun, getChainRun, preflightAndAccept, retryChainRun } from "../chain-executor.js";
import { compileFrameSteps, compileStoryboardSteps, compileVideoSteps, compileReviseStillStep, goalBriefConstraints, goalPlanSchema, goalStillPrompt, type GoalGenerationStage, type GoalPlan } from "../goal-plan.js";
import { currentGoalCharacters, resolveGoalCharacters } from "../goal-characters.js";
import { goalBriefStyle, goalStylesEqual } from "../goal-styles.js";
import { activeGoalStage, completedGoalVideos, LEGACY_GOAL_MESSAGE, publicGoal, reconcileGoal } from "../goal-state.js";
import { goalStillAttempts, goalStillStaleReason } from "../goal-stills.js";
import {
  createGoalCell, emptyGoalEstimates, findGoalCell, goalContent, listGoals, readGoal, readGoalCell, requireGoalContent, saveGoal,
  writeGoalContent, type GoalRecord, type GoalStageOutput,
} from "../goal-store.js";
import { estimateGoal } from "../jobs/plan-goal.js";
import { queueGoalCombination } from "../jobs/combine-goal.js";
import { mutateNotebook, withNotebookMutation } from "../notebook-mutations.js";
import { arrangeGoalNotebook } from "../notebook-goal-layout.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const failure = (error: unknown): ToolResult => ({ isError: true, content: [{ type: "text", text: errorMessage(error) }] });
const ACTIVE_STATUSES = new Set(["planning", "review", "running"]);
type GoalArgs = Record<string, unknown>;
const stillStageSchema = z.enum(["frame", "storyboards"]);
const feedbackSchema = z.string().trim().min(1).max(300).regex(/^[^@]*$/u, "Use plain text without @ references in revision feedback");
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
    arrangeGoalNotebook(document, { generators: count, images: stage === "videos" ? 0 : count, videos: stage === "videos" ? count : 0, timelines: needsTimeline ? 1 : 0 });
    const arranged = arrangeGoalNotebook(document);
    if (!needsTimeline) return arranged;
    const timeline = engine.notebooks.createCell({ type: "timeline", label: plan.title, slot: firstEmptyNotebookGridRow(notebookOccupiedSlots(arranged.cells)) });
    return arrangeGoalNotebook({ ...arranged, cells: [...arranged.cells, timeline] });
  });
  if (!placed.ok) throw new Error(placed.error.message);
}

async function startStage(engine: Engine, goal: GoalRecord, args: GoalArgs, regenerate: boolean): Promise<GoalRecord> {
  requireModernGoal(goal);
  const content = requireGoalContent(engine, goal);
  if (!regenerate && goal.status === "running" && goal.stages[activeGoalStage(goal)]?.revision === args.revision) return goal;
  if (goal.status !== "review") throw new Error("Review the goal before approving, regenerating or revising a stage");
  const plan = requireRevision(engine, goal, args.revision);
  const feedback = args.action === "revise" ? feedbackSchema.parse(args.feedback) : null;
  if (!process.env.KIE_API_KEY) throw new Error("Set KIE_API_KEY in Settings before generating this stage");
  const stage: GoalGenerationStage = regenerate
    ? args.stage !== undefined || feedback ? stillStageSchema.parse(args.stage)
      : goal.stage === "storyboards" ? "frame" : goal.stage === "videos" ? "storyboards" : (() => { throw new Error("There are no stage outputs to regenerate yet"); })()
    : activeGoalStage(goal);
  const index = regenerate && (args.index !== undefined || feedback) ? z.number().int().nonnegative().parse(args.index) : null;
  if (regenerate) {
    if (stage === "videos") throw new Error("Only stills can be regenerated or revised");
    if (index !== null) goalStillPrompt(plan, stage, index);
    if (!goal.stages[stage]?.outputs.some(output => index === null || output.index === index)) throw new Error("There is no current still to regenerate or revise");
  }
  const indexes = index !== null ? [index] : stage === "frame" ? [0]
    : regenerate && Array.isArray(args.shot_indexes) ? [...new Set(z.array(z.number().int().min(0).max(plan.shots.length - 1)).min(1).parse(args.shot_indexes))].sort((a, b) => a - b)
      : plan.shots.map((_, index) => index);
  let document = readNotebook(engine, goal.notebookId);
  let characters = currentGoalCharacters(document, content.characters);
  if (characters.length === 0) throw new Error("This goal has no character images. Start a new /goal.");
  if (stage !== "frame") {
    const frame = goal.stages.frame?.outputs[0];
    outputReference(document, frame);
    const stale = goalStillStaleReason(engine, goal, document, plan, characters, "frame", frame!);
    if (stale) throw new Error(stale);
  }
  if (stage === "videos") {
    for (const output of goal.stages.storyboards?.outputs ?? []) {
      const stale = goalStillStaleReason(engine, goal, document, plan, characters, "storyboards", output);
      if (stale) throw new Error(stale);
    }
  }
  const track = stage === "videos" && plan.shots.length > 1
    ? engine.sequences.getPrimary().tracks.find(candidate => candidate.kind === "video" && candidate.enabled && !candidate.locked) : null;
  if (stage === "videos" && plan.shots.length > 1 && !track) throw new Error("The sequence needs an enabled, unlocked video track");
  const count = stage === "frame" || feedback || index !== null ? 1 : indexes.length * (stage === "storyboards" && plan.frameContinuity ? 2 : 1);
  await ensureStageSpace(engine, goal, stage, count, plan);
  document = readNotebook(engine, goal.notebookId);
  characters = currentGoalCharacters(document, content.characters);
  const steps = feedback && stage !== "videos" ? [compileReviseStillStep(plan, characters, stage, index!,
    outputReference(document, goal.stages[stage]?.outputs.find(output => output.index === index)), feedback,
    stage === "storyboards" ? outputReference(document, goal.stages.frame?.outputs[0]) : undefined)]
    : stage === "frame" ? compileFrameSteps(plan, characters)
    : stage === "storyboards" ? compileStoryboardSteps(plan, characters, outputReference(document, goal.stages.frame?.outputs[0]), indexes.map(position => position % plan.shots.length))
      .filter(step => index === null || step.id === `storyboard${index + 1}`)
      : compileVideoSteps(goal.goalId, plan,
        plan.shots.map((_, index) => outputReference(document, goal.stages.storyboards?.outputs.find(output => output.index === index))),
        plan.frameContinuity ? plan.shots.map((_, index) => outputReference(document, goal.stages.storyboards?.outputs.find(output => output.index === index + plan.shots.length))) : []);
  const { defs, lookup } = await goalToolLookup(engine);
  const chain = await preflightAndAccept({
    action: "run", version: 1, book_id: goal.bookId, notebook_id: goal.notebookId,
    request_id: `goal:${goal.goalId}:${stage}:${content.revision}${feedback ? `:revise:${index}:${goal.stages[stage]?.attempts?.length ?? 0}` : regenerate ? `:regenerate:${indexes.join(",")}:${goal.stages[stage]?.attempts?.length ?? 0}` : ""}`, steps,
  }, {
    engine, bookId: goal.bookId, notebookId: goal.notebookId,
    toolSchemas: new Map(defs.map(def => [def.name, def.schema])), autoApplyTools: new Set(),
    effectForTool: name => name === "assemble_goal" ? "mutation" : "generation",
  }, lookup, { actor: "chat" });
  const previous = goal.stages[stage];
  const approvedAt = new Date().toISOString();
  return saveGoal(engine, {
    ...goal, stage, chainId: chain.chainId, status: "running", error: null, resumeStage: regenerate ? goal.stage : null,
    ...(stage === "videos" ? { clipIds: plan.shots.map(() => uuidv7()), trackId: track?.trackId ?? null } : {}),
    stages: { ...goal.stages, [stage]: {
      chainId: chain.chainId, revision: content.revision, approvedAt, shotIndexes: indexes,
      outputs: previous?.outputs ?? [], previousChainIds: previous ? [...previous.previousChainIds, previous.chainId] : [],
      ...(stage !== "videos" ? { attempts: goalStillAttempts(goal, plan, stage, chain.chainId, steps, approvedAt, feedback) } : {}),
    } },
  });
}

function selectStill(engine: Engine, goal: GoalRecord, args: GoalArgs): GoalRecord {
  requireModernGoal(goal);
  if (goal.status !== "review") throw new Error("Select a still while reviewing the goal");
  const stage = z.enum(["frame", "storyboards"]).parse(args.stage);
  const index = z.number().int().nonnegative().parse(args.index);
  const artifactId = z.string().uuid().parse(args.artifact_id);
  const run = goal.stages[stage];
  const attempt = run?.attempts?.find(item => item.stage === stage && item.index === index && item.artifactId === artifactId);
  const step = attempt ? getChainRun(engine, attempt.chainId)?.steps.find(item => item.id === attempt.stepId) : null;
  if (!run || !attempt || step?.status !== "completed") throw new Error("Choose a completed version of this goal's still");
  const document = readNotebook(engine, goal.notebookId);
  const producer = document.cells.find(cell => cell.inputs?.chainRunId === `${attempt.chainId}:${attempt.stepId}`);
  const output = { index, artifactId, cellId: attempt.cellId, producerCellId: producer?.id ?? null, address: null };
  const address = outputReference(document, output);
  return saveGoal(engine, { ...goal, stages: { ...goal.stages, [stage]: {
    ...run, outputs: [...run.outputs.filter(item => item.index !== index), { ...output, address }].sort((a, b) => a.index - b.index),
  } } });
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
    const cell = await createGoalCell(engine, notebookId, goalId, {
      brief, characters, revision: plan ? 1 : 0, plan, estimate,
      ...(!plan ? { requestedStyle: goalBriefStyle(brief) } : {}),
    });
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
    || previous.continuity !== plan.continuity || previous.shots.length !== plan.shots.length || !goalStylesEqual(previous.style, plan.style)) {
    throw new Error("The characters, visual style, format and shot count are fixed after generating the full frame. Start a new goal to change them.");
  }
  if (previous.frameContinuity !== plan.frameContinuity) throw new Error("Choose ending frames before generating the full frame. Start a new goal to change this setting.");
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

function stopStillRun(engine: Engine, goal: GoalRecord): GoalRecord | null {
  const stage = activeGoalStage(goal);
  const run = goal.stages[stage];
  const previousChainId = run?.previousChainIds.at(-1);
  if (goal.status !== "running" || !goal.resumeStage || stage === "videos" || !run || !previousChainId || !goal.chainId) return null;
  cancelChainRun(engine, goal.chainId);
  return saveGoal(engine, {
    ...goal, status: "review", stage: goal.resumeStage, chainId: previousChainId, error: null, resumeStage: null,
    stages: { ...goal.stages, [stage]: {
      ...run, chainId: previousChainId, previousChainIds: [...run.previousChainIds.slice(0, -1), run.chainId],
      ...(run.attempts ? { attempts: run.attempts.filter(attempt => attempt.chainId !== run.chainId) } : {}),
    } },
  });
}

async function cancelGoal(engine: Engine, goal: GoalRecord, options: { discard?: boolean } = {}): Promise<GoalRecord> {
  if (!ACTIVE_STATUSES.has(goal.status)) return goal;
  const resumed = options.discard ? null : stopStillRun(engine, goal);
  if (resumed) return resumed;
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
  if (args.action === "select") return selectStill(engine, goal, args);
  if (args.action === "approve" || args.action === "regenerate" || args.action === "revise") return startStage(engine, goal, args, args.action !== "approve");
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
      else await cancelGoal(engine, readGoal(engine, goal.goalId), { discard: true });
    });
  }
  return snapshots;
}

export function goalDefs(engine: Engine): ToolDef[] {
  return [{
    name: "video_goal", scope: "book",
    description: "Create a video goal from character images in Cinematic (default) or IG Influencer style. IG Influencer is hyper-realistic iPhone footage; mention the style and GRWM, OOTD or another content format, delivery, camera and light in the brief, or supply plan.style with id and options. Style and its options are editable before the full frame and fixed afterwards. Default to portrait 9:16, three 10-second clips, Sunburst 2K stills and Seedance 720p video. Review the compact plan, then explicitly approve each paid stage: frame, four-panel storyboards and videos. Each storyboard is a 2x2 sequence of setup, action, reaction and ending; videos use the sheet as a reference, never as a literal first frame. Legacy single-frame previews need regeneration or revision before video approval. Every still attempt is kept. select chooses a completed version using stage, index and artifact_id without changing the plan revision. revise uses the current revision, stage, index and plain-text feedback (1–300 characters, no @ references) to edit the selected still. regenerate makes a fresh still using stage/index, or selected storyboard pairs using shot_indexes. The full frame can be revised from either still review. Older storyboard actions, durations, prompts or full-frame references make stills stale and block approval until refreshed or restored. Advanced plan.frameContinuity adds ending frames; each can be revised independently, and video uses the storyboard plus its ending reference. update saves edits; cancel stops a running still revision or regeneration and returns to its review with the previous version, otherwise it stops the goal; retry resumes failed work, and dismiss hides a finished goal. Multiple clips append in order; combine renders one video locally with sound and reuses completed output. The goal tile holds its plan and characters; deleting it stops the goal.",
    schema: {
      book_id: z.string().uuid(), notebook_id: z.string().uuid(),
      action: z.enum(["create", "list", "status", "update", "approve", "regenerate", "select", "revise", "cancel", "assemble", "retry", "dismiss", "combine"]),
      goal_id: z.string().uuid().optional(), request_id: z.string().min(1).max(200).optional(),
      brief: z.string().trim().min(1).max(6000).optional(), plan: goalPlanSchema.optional(),
      revision: z.number().int().nonnegative().optional(), shot_indexes: z.array(z.number().int().min(0).max(7)).min(1).max(8).optional(),
      stage: stillStageSchema.optional(), index: z.number().int().min(0).max(15).optional(), artifact_id: z.string().uuid().optional(), feedback: feedbackSchema.optional(),
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
