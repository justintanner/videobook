import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine, NotebookDocument } from "videobook-engine";
import { resolveNotebookCellArtifactId } from "videobook-engine";
import { firstEmptyNotebookGridRow, notebookGridTag, notebookOccupiedSlots, NOTEBOOK_GRID_CAPACITY } from "videobook-engine/notebook-grid";
import { queue } from "../queue.js";
import { cancelChainRun, getChainRun, preflightAndAccept, retryChainRun } from "../chain-executor.js";
import { compileFrameSteps, compileGoalV3Approval, compileStoryboardSteps, compileVideoSteps, compileReviseStillStep, goalBriefConstraints, goalPlanSchema, goalPlanV3Schema, goalStillPrompt, isGoalPlanV3, refreshGoalPlanV3, type GoalGenerationStage, type GoalPlan } from "../goal-plan.js";
import { buildGoalPlanV3, type GoalPlanV3 } from "../goal-plan-v3.js";
import { estimateGoalV3, goalMediaCharacters, resolveGoalMediaReferences, captureGoalSceneFrame } from "../goal-v3-runtime.js";
import { currentGoalCharacters, resolveGoalCharacters } from "../goal-characters.js";
import { goalStylesEqual } from "../goal-styles.js";
import { activeGoalStage, completedGoalVideos, LEGACY_GOAL_MESSAGE, publicGoal, reconcileFinish, reconcileGoal } from "../goal-state.js";
import { goalAttemptFingerprints, goalStageAttempts, goalStageFingerprint, goalStillAttempts, goalStillStaleReason, goalV3Fingerprint } from "../goal-stills.js";
import {
  createGoalCell, findGoalCell, goalContent, listGoals, readGoal, readGoalCell, requireGoalContent, saveGoal,
  writeGoalContent, type GoalRecord, type GoalStageOutput,
} from "../goal-store.js";
import { estimateGoal } from "../jobs/plan-goal.js";
import { queueGoalCombination } from "../jobs/combine-goal.js";
import { queueGoalFinish } from "../jobs/finish-goal.js";
import { mutateNotebook, withNotebookMutation } from "../notebook-mutations.js";
import { arrangeGoalNotebook } from "../notebook-goal-layout.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const failure = (error: unknown): ToolResult => ({ isError: true, content: [{ type: "text", text: errorMessage(error) }] });
const ACTIVE_STATUSES = new Set(["planning", "review", "running"]);
const V3_ASSEMBLY_MESSAGE = "Scene and video goals do not use storyboard editing or multi-clip assembly.";
const V3_FINISH_REVIEW_MESSAGE = "The video is in finishing review. Revise the scene or video before generating again.";
const V3_SETTINGS_MESSAGE = "Scene and video settings stay with this goal. Start a new goal to change them.";
const STALE_RETRY_MESSAGE = "The references or selected versions changed after this attempt. Regenerate using the current selection instead of retrying the older request.";
type GoalArgs = Record<string, unknown>;
const stageSchema = z.enum(["frame", "storyboards", "videos"]);
const feedbackSchema = z.string().trim().min(1).max(300).regex(/^[^@]*$/u, "Use plain text without @ references in revision feedback");
export type GoalSnapshot = Awaited<ReturnType<typeof publicGoal>>;

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

function requireModernGoal(goal: GoalRecord): void {
  if (goal.planVersion === 3) throw new Error(V3_ASSEMBLY_MESSAGE);
  if (goal.planVersion !== 2) throw new Error(LEGACY_GOAL_MESSAGE);
}

function assertRevision(engine: Engine, goal: GoalRecord, revision: unknown) {
  const content = requireGoalContent(engine, goal);
  if (content.revision !== revision) throw new Error("The goal changed. Review the current version before approving it.");
  return content;
}

function requireRevision(engine: Engine, goal: GoalRecord, revision: unknown): GoalPlan {
  return goalPlanSchema.parse(assertRevision(engine, goal, revision).plan);
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

async function ensureV3Space(engine: Engine, goal: GoalRecord, stage: "frame" | "videos"): Promise<void> {
  const placed = await mutateNotebook(engine, goal.notebookId, "goal_stage_space", document => {
    const occupied = notebookOccupiedSlots(document.cells);
    if (NOTEBOOK_GRID_CAPACITY - occupied.length < 2) {
      throw new Error("The notebook needs two empty cells per stage output and a row for the timeline when combining clips");
    }
    return arrangeGoalNotebook(document, { generators: 1, images: stage === "videos" ? 0 : 1, videos: stage === "videos" ? 1 : 0 });
  });
  if (!placed.ok) throw new Error(placed.error.message);
}

function v3Stage(goal: GoalRecord, args: GoalArgs, regenerate: boolean): "frame" | "videos" {
  if (!regenerate) return goal.stage === "videos" ? "videos" : "frame";
  const requested = args.stage !== undefined || args.action === "revise" ? stageSchema.parse(args.stage) : goal.stage === "videos" ? "frame" : null;
  if (requested === "storyboards") throw new Error(V3_ASSEMBLY_MESSAGE);
  if (requested !== "frame" && requested !== "videos") throw new Error("There are no stage outputs to regenerate yet");
  return requested;
}

async function startV3Stage(engine: Engine, goal: GoalRecord, args: GoalArgs, regenerate: boolean): Promise<GoalRecord> {
  if (!regenerate && goal.status === "running" && goal.stages[activeGoalStage(goal)]?.revision === args.revision) return goal;
  if (!(regenerate ? ["review", "completed", "failed", "interrupted"] : ["review"]).includes(goal.status)) throw new Error("Review the goal before approving, regenerating or revising a stage");
  const content = assertRevision(engine, goal, args.revision);
  const stage = v3Stage(goal, args, regenerate);
  const feedback = args.action === "revise" ? feedbackSchema.parse(args.feedback) : null;
  if (regenerate && args.index !== undefined && z.number().int().nonnegative().parse(args.index) !== 0) throw new Error("There is no current output to regenerate or revise");
  if (regenerate && !goal.stages[stage]?.outputs.length) throw new Error("There is no current output to regenerate or revise");
  if (!regenerate && stage === "videos" && goal.finish) throw new Error(V3_FINISH_REVIEW_MESSAGE);
  if (!process.env.KIE_API_KEY) throw new Error("Set KIE_API_KEY in Settings before generating this stage");
  if (stage === "videos") outputReference(readNotebook(engine, goal.notebookId), goal.stages.frame?.outputs[0]);
  await ensureV3Space(engine, goal, stage);
  const document = readNotebook(engine, goal.notebookId);
  const plan = refreshGoalPlanV3(goalPlanV3Schema.parse(content.plan), document);
  const sceneOutput = goal.stages.frame?.outputs[0];
  const sceneAddress = stage === "videos" ? outputReference(document, sceneOutput) : undefined;
  if (stage === "videos" && sceneOutput) {
    const sceneAttempt = goal.stages.frame?.attempts?.find(attempt => attempt.artifactId === sceneOutput.artifactId && attempt.fingerprint);
    if (sceneAttempt?.fingerprint && sceneAttempt.fingerprint !== await goalV3Fingerprint(engine, plan, "frame", null)) {
      throw new Error("The scene has changed. Refresh it before continuing.");
    }
  }
  const compiled = compileGoalV3Approval(plan, stage, sceneAddress);
  const step = feedback ? { ...compiled, params: { ...compiled.params, prompt: `${String(compiled.params.prompt)}\n\n${feedback}` } } : compiled;
  const fingerprint = await goalV3Fingerprint(engine, plan, stage, stage === "videos" ? sceneOutput?.artifactId ?? null : null);
  const { defs, lookup } = await goalToolLookup(engine);
  const chain = await preflightAndAccept({
    action: "run", version: 1, book_id: goal.bookId, notebook_id: goal.notebookId,
    request_id: `goal:${goal.goalId}:${stage}:${content.revision}${feedback ? `:revise:0:${goal.stages[stage]?.attempts?.length ?? 0}` : regenerate ? `:regenerate:0:${goal.stages[stage]?.attempts?.length ?? 0}` : ""}`,
    steps: [step],
  }, {
    engine, bookId: goal.bookId, notebookId: goal.notebookId,
    toolSchemas: new Map(defs.map(def => [def.name, def.schema])), autoApplyTools: new Set(),
    effectForTool: name => name === "assemble_goal" ? "mutation" : "generation",
  }, lookup, { actor: "chat" });
  const previous = goal.stages[stage];
  const approvedAt = new Date().toISOString();
  const { finish: _finish, ...stored } = goal;
  return saveGoal(engine, {
    ...(regenerate ? stored : goal),
    stage, chainId: chain.chainId, status: "running", error: null,
    ...(regenerate ? { finish: null, resumeFinish: goal.finish ?? null } : {}),
    resumeStage: regenerate ? goal.resumeStage ?? goal.stage : null,
    resumeStatus: regenerate ? goal.status === "completed" || goal.resumeStatus === "completed" ? "completed" : "review" : null,
    resumeOutputs: regenerate ? previous?.outputs ?? [] : null,
    stages: { ...goal.stages, [stage]: {
      chainId: chain.chainId, revision: content.revision, approvedAt, shotIndexes: [0],
      outputs: previous?.outputs ?? [], previousChainIds: previous ? [...previous.previousChainIds, previous.chainId] : [],
      attempts: [...(previous?.attempts ?? []), {
        stage, index: 0, chainId: chain.chainId, stepId: step.id, artifactId: null, cellId: null,
        basePrompt: stage === "videos" ? plan.video.prompt : plan.scene.prompt, feedback, fingerprint,
        parentArtifactId: feedback ? previous?.outputs[0]?.artifactId ?? null : null,
        frameArtifactId: stage === "videos" ? sceneOutput?.artifactId ?? null : null, createdAt: approvedAt,
      }],
    } },
  });
}

async function startStage(engine: Engine, goal: GoalRecord, args: GoalArgs, regenerate: boolean): Promise<GoalRecord> {
  if (goal.planVersion === 1) throw new Error(LEGACY_GOAL_MESSAGE);
  if (goal.planVersion === 3) return startV3Stage(engine, goal, args, regenerate);
  requireModernGoal(goal);
  const content = requireGoalContent(engine, goal);
  if (!regenerate && goal.status === "running" && goal.stages[activeGoalStage(goal)]?.revision === args.revision) return goal;
  if (!(regenerate ? ["review", "completed", "failed", "interrupted"] : ["review"]).includes(goal.status)) throw new Error("Review the goal before approving, regenerating or revising a stage");
  const plan = requireRevision(engine, goal, args.revision);
  const feedback = args.action === "revise" ? feedbackSchema.parse(args.feedback) : null;
  if (!process.env.KIE_API_KEY) throw new Error("Set KIE_API_KEY in Settings before generating this stage");
  const stage: GoalGenerationStage = regenerate
    ? args.stage !== undefined || feedback ? stageSchema.parse(args.stage)
      : goal.stage === "storyboards" ? "frame" : goal.stage === "videos" ? "storyboards" : (() => { throw new Error("There are no stage outputs to regenerate yet"); })()
    : activeGoalStage(goal);
  const index = regenerate && (args.index !== undefined || feedback) ? z.number().int().nonnegative().parse(args.index) : null;
  if (regenerate) {
    if (index !== null && stage !== "videos") goalStillPrompt(plan, stage, index);
    if (stage === "videos" && index !== null && !plan.shots[index]) throw new Error("There is no video at this index");
    if (!goal.stages[stage]?.outputs.some(output => index === null || output.index === index)) throw new Error("There is no current output to regenerate or revise");
  }
  const indexes = index !== null ? [index] : stage === "frame" ? [0]
    : regenerate && Array.isArray(args.shot_indexes) ? [...new Set(z.array(z.number().int().min(0).max(plan.shots.length - 1)).min(1).parse(args.shot_indexes))].sort((a, b) => a - b)
      : plan.shots.map((_, index) => index);
  let document = readNotebook(engine, goal.notebookId);
  let characters = currentGoalCharacters(document, content.characters);
  if (characters.length === 0) throw new Error("This goal has no reference images. Start a new /goal.");
  if (stage !== "frame") {
    const frame = goal.stages.frame?.outputs[0];
    outputReference(document, frame);
    const stale = await goalStillStaleReason(engine, goal, document, plan, characters, "frame", frame!);
    if (stale) throw new Error(stale);
  }
  if (stage === "videos") {
    for (const output of goal.stages.storyboards?.outputs ?? []) {
      if (!indexes.includes(output.index % plan.shots.length)) continue;
      const stale = await goalStillStaleReason(engine, goal, document, plan, characters, "storyboards", output);
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
        plan.frameContinuity ? plan.shots.map((_, index) => outputReference(document, goal.stages.storyboards?.outputs.find(output => output.index === index + plan.shots.length))) : [],
        { frame: outputReference(document, goal.stages.frame?.outputs[0]), characters, indexes, feedback, assemble: !regenerate });
  const fingerprints = await goalAttemptFingerprints(engine, goal, plan, characters, stage, steps);
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
    ...goal, stage, chainId: chain.chainId, status: "running", error: null, resumeStage: regenerate ? goal.resumeStage ?? goal.stage : null,
    resumeStatus: regenerate ? goal.status === "completed" || goal.resumeStatus === "completed" ? "completed" : "review" : null, resumeOutputs: regenerate ? previous?.outputs ?? [] : null,
    ...(stage === "videos" ? { clipIds: goal.clipIds.length === plan.shots.length ? goal.clipIds : plan.shots.map(() => uuidv7()), trackId: goal.trackId ?? track?.trackId ?? null } : {}),
    stages: { ...goal.stages, [stage]: {
      chainId: chain.chainId, revision: content.revision, approvedAt, shotIndexes: indexes,
      outputs: previous?.outputs ?? [], previousChainIds: previous ? [...previous.previousChainIds, previous.chainId] : [],
      attempts: goalStillAttempts(goal, plan, stage, chain.chainId, steps, approvedAt, feedback, fingerprints, goalStageAttempts(engine, goal, stage)),
    } },
  });
}

function selectV3Version(engine: Engine, goal: GoalRecord, args: GoalArgs): GoalRecord {
  if (!["review", "completed", "failed", "interrupted"].includes(goal.status)) throw new Error("Select a version while reviewing the goal");
  if (args.revision !== undefined) assertRevision(engine, goal, args.revision);
  const stage = stageSchema.parse(args.stage);
  if (stage === "storyboards") throw new Error(V3_ASSEMBLY_MESSAGE);
  const index = z.number().int().nonnegative().parse(args.index);
  const artifactId = z.string().uuid().parse(args.artifact_id);
  const run = goal.stages[stage];
  const attempts = goalStageAttempts(engine, goal, stage);
  const attempt = attempts.find(item => item.stage === stage && item.index === index && item.artifactId === artifactId);
  const step = attempt ? getChainRun(engine, attempt.chainId)?.steps.find(item => item.id === attempt.stepId) : null;
  if (!run || !attempt || step?.status !== "completed") throw new Error("Choose a completed version of this goal's output");
  const document = readNotebook(engine, goal.notebookId);
  const producer = document.cells.find(cell => cell.inputs?.chainRunId === `${attempt.chainId}:${attempt.stepId}`);
  const output = { index, artifactId, cellId: attempt.cellId, producerCellId: producer?.id ?? null, address: null };
  const address = outputReference(document, output);
  const videoChanged = stage === "videos" && run.outputs.find(item => item.index === index)?.artifactId !== artifactId;
  const sceneChanged = stage === "frame" && run.outputs[0]?.artifactId !== artifactId;
  const invalidated = videoChanged || sceneChanged;
  const finish = videoChanged
    ? { status: "review" as const, sourceArtifactId: artifactId, finalArtifactId: null, error: null }
    : sceneChanged ? null : goal.finish ?? null;
  return saveGoal(engine, {
    ...goal,
    ...(invalidated ? { status: "review" as const, error: null } : {}),
    finish,
    stages: { ...goal.stages, [stage]: {
      ...run, attempts, outputs: [...run.outputs.filter(item => item.index !== index), { ...output, address }].sort((a, b) => a.index - b.index),
    } },
  });
}

function selectStill(engine: Engine, goal: GoalRecord, args: GoalArgs): GoalRecord {
  if (goal.planVersion === 1) throw new Error(LEGACY_GOAL_MESSAGE);
  if (goal.planVersion === 3) return selectV3Version(engine, goal, args);
  requireModernGoal(goal);
  if (!["review", "completed", "failed", "interrupted"].includes(goal.status)) throw new Error("Select a version while reviewing the goal");
  if (args.revision !== undefined) requireRevision(engine, goal, args.revision);
  const stage = stageSchema.parse(args.stage);
  const index = z.number().int().nonnegative().parse(args.index);
  const artifactId = z.string().uuid().parse(args.artifact_id);
  const run = goal.stages[stage];
  const attempts = goalStageAttempts(engine, goal, stage);
  const attempt = attempts.find(item => item.stage === stage && item.index === index && item.artifactId === artifactId);
  const step = attempt ? getChainRun(engine, attempt.chainId)?.steps.find(item => item.id === attempt.stepId) : null;
  if (!run || !attempt || step?.status !== "completed") throw new Error("Choose a completed version of this goal's output");
  const document = readNotebook(engine, goal.notebookId);
  const producer = document.cells.find(cell => cell.inputs?.chainRunId === `${attempt.chainId}:${attempt.stepId}`);
  const output = { index, artifactId, cellId: attempt.cellId, producerCellId: producer?.id ?? null, address: null };
  const address = outputReference(document, output);
  return saveGoal(engine, { ...goal, ...(stage === "videos" && goal.combined && run.outputs.find(item => item.index === index)?.artifactId !== artifactId ? { combined: { ...goal.combined, status: "failed" as const, error: "Video selection changed. Assemble the selected clips before combining again." } } : {}), stages: { ...goal.stages, [stage]: {
    ...run, attempts, outputs: [...run.outputs.filter(item => item.index !== index), { ...output, address }].sort((a, b) => a.index - b.index),
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
    const document = readNotebook(engine, notebookId);
    const supplied = args.plan === undefined ? undefined : z.union([goalPlanV3Schema, goalPlanSchema]).parse(args.plan);
    const goalId = uuidv7();
    const timestamp = new Date().toISOString();
    if (supplied === undefined || isGoalPlanV3(supplied)) {
      const sourced = supplied === undefined
        ? await resolveGoalMediaReferences(engine, document, brief)
        : supplied.references;
      const plan = supplied ?? buildGoalPlanV3({ brief, references: sourced, frame: await captureGoalSceneFrame(engine, notebookId, sourced) });
      const media = plan.references;
      const characters = goalMediaCharacters(media);
      const estimate = await estimateGoalV3(engine, plan);
      const cell = await createGoalCell(engine, notebookId, goalId, { brief, characters, media, revision: 1, plan, estimate });
      const goal = saveGoal(engine, {
        goalId, bookId, notebookId, cellId: cell.id, requestId, status: "review", planVersion: 3, stage: "frame", stages: {},
        chainId: null, planningJobId: null, clipIds: [], trackId: null, assembly: null, error: null,
        dismissedAt: null, createdAt: timestamp, updatedAt: timestamp,
      });
      return goalSnapshot(engine, goal);
    }
    goalBriefConstraints(brief);
    const characters = resolveGoalCharacters(engine, document, brief);
    const plan = supplied;
    const estimate = await estimateGoal(engine, plan, characters);
    const cell = await createGoalCell(engine, notebookId, goalId, { brief, characters, revision: 1, plan, estimate });
    const goal = saveGoal(engine, {
      goalId, bookId, notebookId, cellId: cell.id, requestId, status: "review", planVersion: 2, stage: "frame", stages: {},
      chainId: null, planningJobId: null, clipIds: [], trackId: null, assembly: null, error: null,
      dismissedAt: null, createdAt: timestamp, updatedAt: timestamp,
    });
    return goalSnapshot(engine, goal);
  });
}

function validateReviewEdit(goal: GoalRecord, previous: GoalPlan, plan: GoalPlan): void {
  if (!Object.values(goal.stages).some(run => run.outputs.length > 0)) return;
  if (previous.storyboardLayout === "six-panel") {
    if (previous.shots.length !== plan.shots.length || previous.frameContinuity !== plan.frameContinuity || previous.storyboardLayout !== plan.storyboardLayout) throw new Error("Keep the clip count and storyboard layout after generation. Start a new goal to change them.");
    return;
  }
  if (goal.stage === "frame") return;
  if (previous.aspectRatio !== plan.aspectRatio || previous.imageModel !== plan.imageModel || previous.imageResolution !== plan.imageResolution
    || previous.continuity !== plan.continuity || previous.shots.length !== plan.shots.length || !goalStylesEqual(previous.style, plan.style)) {
    throw new Error("The characters, visual style, format and shot count are fixed after generating the full frame. Start a new goal to change them.");
  }
  if (previous.frameContinuity !== plan.frameContinuity) throw new Error("Choose ending frames before generating the full frame. Start a new goal to change this setting.");
}

function v3LockedShape(plan: GoalPlanV3): string {
  const ref = (item: GoalPlanV3["references"][number]) => ({
    kind: item.kind, artifactId: item.artifactId, cellId: item.cellId, slot: item.slot, objectHash: item.objectHash,
  });
  return JSON.stringify({
    aspectRatio: plan.aspectRatio,
    scene: { ...plan.scene, prompt: "", imageRefs: plan.scene.imageRefs.map(ref) },
    video: {
      ...plan.video, prompt: "",
      imageRefs: plan.video.imageRefs.map(ref), videoRefs: plan.video.videoRefs.map(ref),
    },
    references: plan.references.map(ref),
    sampledFrames: plan.sampledFrames,
    finish: plan.finish,
  });
}

async function updateV3Goal(engine: Engine, goal: GoalRecord, args: GoalArgs): Promise<GoalRecord> {
  if (!["review", "completed", "failed", "interrupted"].includes(goal.status)) throw new Error("Wait until generation stops before editing the goal");
  const content = assertRevision(engine, goal, args.revision);
  const previous = goalPlanV3Schema.parse(content.plan);
  const supplied = args.plan;
  if (!supplied || typeof supplied !== "object" || !("version" in supplied) || supplied.version !== 3) throw new Error(V3_ASSEMBLY_MESSAGE);
  const plan = goalPlanV3Schema.parse(supplied);
  if (v3LockedShape(previous) !== v3LockedShape(plan)) throw new Error(V3_SETTINGS_MESSAGE);
  if (JSON.stringify(previous) === JSON.stringify(plan)) return goal;
  const promptChanged = previous.scene.prompt !== plan.scene.prompt || previous.video.prompt !== plan.video.prompt;
  await writeGoalContent(engine, goal, { ...content, plan, revision: content.revision + 1 });
  return saveGoal(engine, {
    ...goal,
    ...(promptChanged ? { status: "review" as const, error: null, finish: null } : {}),
  });
}

async function updateGoal(engine: Engine, goal: GoalRecord, args: GoalArgs): Promise<GoalRecord> {
  if (goal.planVersion === 3) return updateV3Goal(engine, goal, args);
  requireModernGoal(goal);
  if (!["review", "completed", "failed", "interrupted"].includes(goal.status)) throw new Error("Wait until generation stops before editing the goal");
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
  if (goal.planVersion === 3 && goal.finish?.status === "running") {
    if (goal.finish.jobId) await engine.jobs.queue.abort(goal.finish.jobId, "Finishing cancelled");
    return saveGoal(engine, { ...goal, status: "review", error: null, finish: { ...goal.finish, status: "cancelled", error: null } });
  }
  if (!ACTIVE_STATUSES.has(goal.status)) return goal;
  const resumed = options.discard ? null : stopStillRun(engine, goal);
  if (resumed) return resumed;
  const cancelled = saveGoal(engine, { ...goal, status: "cancelled", error: null });
  if (cancelled.chainId) cancelChainRun(engine, cancelled.chainId);
  if (cancelled.planningJobId) await engine.jobs.queue.abort(cancelled.planningJobId, "Goal cancelled");
  return cancelled;
}

async function retryV3Goal(engine: Engine, goal: GoalRecord): Promise<GoalRecord> {
  if (goal.status !== "failed" && goal.status !== "interrupted") throw new Error("Only a goal that failed or was interrupted can be retried");
  const content = requireGoalContent(engine, goal);
  if (!goal.chainId) throw new Error("There is no generation to retry. Approve the current stage.");
  const stage = activeGoalStage(goal);
  if (stage === "storyboards") throw new Error(V3_ASSEMBLY_MESSAGE);
  const run = goal.stages[stage];
  if (run && run.revision !== content.revision) throw new Error("The plan changed after this attempt. Regenerate using the current plan instead of retrying the older request.");
  const plan = refreshGoalPlanV3(goalPlanV3Schema.parse(content.plan), readNotebook(engine, goal.notebookId));
  const sceneArtifactId = stage === "videos" ? goal.stages.frame?.outputs[0]?.artifactId ?? null : null;
  for (const attempt of run?.attempts ?? []) {
    if (attempt.chainId !== goal.chainId || !attempt.fingerprint) continue;
    if (attempt.fingerprint !== await goalV3Fingerprint(engine, plan, stage, sceneArtifactId)) throw new Error(STALE_RETRY_MESSAGE);
  }
  if (!process.env.KIE_API_KEY) throw new Error("Set KIE_API_KEY in Settings before retrying this stage");
  const { lookup } = await goalToolLookup(engine);
  retryChainRun(engine, goal.chainId, lookup);
  return saveGoal(engine, { ...goal, status: "running", error: null });
}

async function retryGoal(engine: Engine, goal: GoalRecord): Promise<GoalRecord> {
  if (goal.planVersion === 1) throw new Error(LEGACY_GOAL_MESSAGE);
  if (goal.planVersion === 3) return retryV3Goal(engine, goal);
  requireModernGoal(goal);
  if (goal.status !== "failed" && goal.status !== "interrupted") throw new Error("Only a goal that failed or was interrupted can be retried");
  const content = requireGoalContent(engine, goal);
  if (!goal.chainId) return queuePlanning(engine, goal, `goal-plan-${goal.goalId}-${uuidv7()}`);
  const stage = activeGoalStage(goal);
  const run = goal.stages[stage];
  if (run && run.revision !== content.revision) throw new Error("The plan changed after this attempt. Regenerate using the current plan instead of retrying the older request.");
  const plan = goalPlanSchema.parse(content.plan);
  for (const attempt of run?.attempts ?? []) {
    if (attempt.chainId !== goal.chainId || !attempt.fingerprint) continue;
    if (attempt.fingerprint !== await goalStageFingerprint(engine, goal, plan, content.characters, stage, attempt.index)) {
      throw new Error(STALE_RETRY_MESSAGE);
    }
  }
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
  if (args.action === "finish") return queueGoalFinish(engine, goal, args);
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
    description: "Create a goal from image and video references. A new goal with no supplied plan is one concise scene and one Seedance 2.5 video: Nano Banana 2.1 at 16:9, 2K, JPG, then 16:9, 1080p, 13 seconds, MP4, with audio. Portrait or square only when the brief says so. No storyboard, ending frame, or style preset. Approving a new goal generates the scene, then the video, and stops at finishing review. finish suggests a 2.3 second cold open, then burns the saved watermark onto a copy after the range is approved. An explicit v2 plan keeps that plan's settings, storyboard, and approval stages. Explicit approval is required before paid generation. update saves a new goal's title and scene or video prompt, or a v2 plan; revise edits a selected image or reruns video with feedback; regenerate makes fresh outputs; select picks any completed version, including after goal completion. Legacy v1 plans stay readable. cancel restores the previous output during revision; retry resumes failed work when the plan and references are unchanged. Multi-clip revisions require explicit assemble and never overwrite user-edited timeline clips; combine renders the selected assembled clips locally. Deleting the goal tile stops it.",
    schema: {
      book_id: z.string().uuid(), notebook_id: z.string().uuid(),
      action: z.enum(["create", "list", "status", "update", "approve", "regenerate", "select", "revise", "cancel", "assemble", "retry", "dismiss", "combine", "finish"]),
      start_seconds: z.number().min(0).optional(), end_seconds: z.number().min(0).optional(),
      goal_id: z.string().uuid().optional(), request_id: z.string().min(1).max(200).optional(),
      brief: z.string().trim().min(1).max(6000).optional(), plan: z.union([goalPlanV3Schema, goalPlanSchema]).optional(),
      revision: z.number().int().nonnegative().optional(), shot_indexes: z.array(z.number().int().min(0).max(7)).min(1).max(8).optional(),
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
