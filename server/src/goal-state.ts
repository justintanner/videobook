import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { cancelChainRun, getChainRun, type ChainRunRecord } from "./chain-executor.js";
import {
  emptyGoalEstimates, findGoalCell, goalShortContent, legacyGoalText, requireGoalShortContent, saveGoal, writeGoalShortContent,
  type GoalGenerationStage, type GoalRecord, type GoalStageOutput,
} from "./goal-store.js";
import { goalStageAttempts } from "./goal-stills.js";
import { refreshGoalShortPlan } from "./goal-short-plan.js";
import { readMainCharacter } from "./goal-short-character.js";
import { currentShortClip, nextShortSegment, shortSegmentStale } from "./goal-short-runtime.js";

export const LEGACY_GOAL_MESSAGE = "This goal was made by an earlier /goal. Its images and videos stay in the notebook. Start a new /goal.";
const SHORT_STALE_MESSAGE = "The frame or an earlier clip changed after this clip was made.";
const REALISM_INTERRUPTED = "The check for AI tells stopped before it answered. Run it again.";
const LEGACY_STAGES = ["frame", "storyboards", "videos"] as const;
const ACTIVE_LEGACY_STATUSES = new Set(["planning", "review", "running"]);

export function activeGoalStage(goal: GoalRecord): GoalGenerationStage {
  return goal.stage === "frame" ? "frame" : "videos";
}

function outputString(outputs: Record<string, unknown> | null, key: string): string | null {
  const value = outputs?.[key];
  return typeof value === "string" ? value : null;
}

function producerCell(document: NotebookDocument, chainId: string, step: ChainRunRecord["steps"][number]): NotebookCell | undefined {
  const tagged = document.cells.filter(cell => cell.inputs?.chainRunId === `${chainId}:${step.id}`).sort((a, b) => b.id.localeCompare(a.id))[0];
  const outputId = outputString(step.outputs, "cell_id");
  const edge = document.edges.find(candidate => candidate.target === outputId && candidate.targetInput === "media");
  return tagged ?? document.cells.find(cell => cell.id === edge?.source);
}

function goalChainSteps(engine: Engine, document: NotebookDocument, chainId: string | null) {
  const chain = chainId ? getChainRun(engine, chainId) : null;
  return chain?.steps.map(step => {
    const producer = producerCell(document, chain!.chainId, step);
    return {
      id: step.id, chainId: chain!.chainId, status: step.status, error: step.error,
      artifactId: outputString(step.outputs, "asset_id") ?? outputString(step.outputs, "img_asset_id") ?? outputString(step.outputs, "vid_asset_id"),
      cellId: producer?.id ?? null,
      address: producer ? notebookGridTag(producer.slot) : outputString(step.outputs, "address"),
      outputCellId: outputString(step.outputs, "cell_id"), startedAt: step.startedAt ?? null,
    };
  }) ?? [];
}

function stageOutputIndex(stepId: string): number {
  if (stepId === "frame") return 0;
  return Number(/\d+$/u.exec(stepId)?.[0]) - 1;
}

function completedStageOutputs(engine: Engine, goal: GoalRecord, document: NotebookDocument): GoalStageOutput[] {
  return goalChainSteps(engine, document, goal.chainId).flatMap(step => {
    if (step.status !== "completed" || !step.artifactId) return [];
    const index = stageOutputIndex(step.id);
    if (!Number.isInteger(index) || index < 0) return [];
    const cell = document.cells.find(candidate => candidate.id === step.outputCellId);
    return [{ index, artifactId: step.artifactId, cellId: step.outputCellId, producerCellId: step.cellId, address: cell ? notebookGridTag(cell.slot) : null }];
  });
}

function allGoalChainSteps(engine: Engine, document: NotebookDocument, chainId: string) {
  return goalChainSteps(engine, document, chainId).flatMap(step => {
    const producers = document.cells.filter(cell => cell.inputs?.chainRunId === `${chainId}:${step.id}`);
    if (producers.length === 0) return [step];
    return producers.map(producer => {
      const outputCellId = document.edges.find(edge => edge.source === producer.id && edge.targetInput === "media")?.target ?? null;
      return { ...step, cellId: producer.id, outputCellId, address: notebookGridTag(producer.slot) };
    });
  });
}

export function reconcileFinish(engine: Engine, goal: GoalRecord): GoalRecord {
  const finish = goal.finish;
  if (goal.planVersion !== 4 || !finish || finish.status !== "running") return goal;
  const job = finish.jobId ? engine.jobs.queue.get(finish.jobId) : null;
  if (job && ["queued", "running", "completing"].includes(job.state)) return goal;
  if (job?.state === "done") {
    const result = job.result && typeof job.result === "object" ? job.result as { finalArtifactId?: unknown; coldOpenArtifactId?: unknown } : null;
    const finalArtifactId = finish.finalArtifactId ?? (typeof result?.finalArtifactId === "string" && result.finalArtifactId ? result.finalArtifactId : null);
    if (finalArtifactId && engine.artifacts.get(finalArtifactId).ok) {
      const coldOpenArtifactId = finish.coldOpenArtifactId ?? (typeof result?.coldOpenArtifactId === "string" ? result.coldOpenArtifactId : null);
      return saveGoal(engine, { ...goal, status: "completed", error: null, finish: { ...finish, status: "completed", finalArtifactId, coldOpenArtifactId, error: null } });
    }
  }
  return saveGoal(engine, { ...goal, status: "review", finish: { ...finish, status: "failed", error: job?.error?.message ?? "Finishing was interrupted. Retry Finish." } });
}

async function settledShortStage(engine: Engine, goal: GoalRecord, next: GoalRecord, stage: GoalGenerationStage, previous: readonly GoalStageOutput[], outputs: readonly GoalStageOutput[]): Promise<GoalRecord> {
  const cleared = { resumeStage: null, resumeStatus: null, resumeOutputs: null, resumeFinish: null };
  const approved = goal.stages[stage]?.shotIndexes ?? [0];
  if (!approved.every(index => outputs.some(output => output.index === index))) {
    return { ...next, status: "failed", error: "The stage finished without its media output. Retry the stage.", ...cleared };
  }
  const content = requireGoalShortContent(engine, goal);
  if (stage === "videos") {
    const clip = content.plan && nextShortSegment(next, content.plan) === null ? currentShortClip(next) : null;
    return { ...next, status: "review", error: null, ...cleared, finish: clip ? { status: "review", sourceArtifactId: clip.artifactId, finalArtifactId: null, error: null } : null };
  }
  await writeGoalShortContent(engine, goal, { ...content, revision: content.revision + 1 });
  const frameChanged = (previous[0]?.artifactId ?? null) !== null && previous[0]?.artifactId !== outputs[0]?.artifactId;
  const finish = frameChanged ? null : goal.finish ?? goal.resumeFinish ?? null;
  const keepCompleted = finish?.status === "completed" && Boolean(finish.finalArtifactId);
  return { ...next, stage: goal.resumeStage ?? "videos", status: keepCompleted ? "completed" : "review", error: null, ...cleared, finish };
}

async function stopLegacyGoal(engine: Engine, goal: GoalRecord): Promise<GoalRecord> {
  if (!ACTIVE_LEGACY_STATUSES.has(goal.status)) return goal;
  if (goal.chainId) cancelChainRun(engine, goal.chainId);
  for (const jobId of [goal.planningJobId, goal.finish?.status === "running" ? goal.finish.jobId : null, goal.combined?.status === "running" ? goal.combined.jobId : null]) {
    if (jobId) await engine.jobs.queue.abort(jobId, LEGACY_GOAL_MESSAGE);
  }
  return saveGoal(engine, { ...goal, status: "failed", error: LEGACY_GOAL_MESSAGE });
}

function settleRealismChecks(engine: Engine, goal: GoalRecord): GoalRecord {
  const stuck = Object.entries(goal.realism ?? {}).flatMap(([artifactId, check]) => {
    if (check.status !== "running" || !check.jobId) return [];
    const job = engine.jobs.queue.get(check.jobId);
    return job && !["failed", "aborted"].includes(job.state) ? [] : [[artifactId, { ...check, status: "failed" as const, checkedAt: new Date().toISOString(), error: job?.error?.message ?? REALISM_INTERRUPTED }] as const];
  });
  return stuck.length === 0 ? goal : saveGoal(engine, { ...goal, realism: { ...goal.realism, ...Object.fromEntries(stuck) } });
}

export async function reconcileGoal(engine: Engine, goal: GoalRecord, document: NotebookDocument): Promise<GoalRecord> {
  if (goal.planVersion !== 4) return stopLegacyGoal(engine, goal);
  goal = settleRealismChecks(engine, goal);
  if (["completed", "cancelled", "review"].includes(goal.status)) return goal;
  if (goal.status === "planning") {
    const job = goal.planningJobId ? engine.jobs.queue.get(goal.planningJobId) : null;
    return job && ["failed", "aborted"].includes(job.state)
      ? saveGoal(engine, { ...goal, status: "failed", error: job.error?.message ?? "Planning was interrupted" }) : goal;
  }
  const stage = activeGoalStage(goal);
  const run = goal.stages[stage];
  const chain = run ? getChainRun(engine, run.chainId) : null;
  if (!run || !chain) return goal;
  const merged = new Map(run.outputs.map(output => [output.index, output]));
  for (const output of completedStageOutputs(engine, goal, document)) merged.set(output.index, output);
  const outputs = [...merged.values()].sort((a, b) => a.index - b.index);
  const attempts = run.attempts?.map(attempt => {
    if (attempt.artifactId) return attempt;
    const step = goalChainSteps(engine, document, attempt.chainId).find(candidate => candidate.id === attempt.stepId);
    return step?.status === "completed" && step.artifactId ? { ...attempt, artifactId: step.artifactId, cellId: step.outputCellId } : attempt;
  });
  let next: GoalRecord = { ...goal, stages: { ...goal.stages, [stage]: { ...run, outputs, ...(attempts ? { attempts } : {}) } } };
  if (chain.status === "completed") {
    next = await settledShortStage(engine, goal, next, stage, run.outputs, outputs);
  } else if (["failed", "interrupted", "cancelled"].includes(chain.status)) {
    next = { ...next, status: chain.status as "failed" | "interrupted" | "cancelled", error: chain.error,
      ...(goal.resumeOutputs ? { stages: { ...next.stages, [stage]: { ...next.stages[stage]!, outputs: goal.resumeOutputs } } } : {}),
    };
  } else {
    next = { ...next, stage, status: "running", error: null };
  }
  return JSON.stringify(next) === JSON.stringify(goal) ? goal : saveGoal(engine, next);
}

function legacyOutputs(engine: Engine, goal: GoalRecord, document: NotebookDocument) {
  const address = (cellId: string | null) => {
    const cell = cellId ? document.cells.find(candidate => candidate.id === cellId) : undefined;
    return cell ? notebookGridTag(cell.slot) : null;
  };
  if (goal.planVersion === 1) {
    return goalChainSteps(engine, document, goal.chainId).flatMap(step => step.status === "completed" && step.artifactId
      ? [{ stage: "videos" as const, artifactId: step.artifactId, cellId: step.outputCellId, address: address(step.outputCellId) }] : []);
  }
  return LEGACY_STAGES.flatMap(stage => [...(goal.stages[stage]?.outputs ?? [])].sort((a, b) => a.index - b.index)
    .map(output => ({ stage, artifactId: output.artifactId, cellId: output.cellId, address: address(output.cellId) })));
}

function legacyGoalSnapshot(engine: Engine, goal: GoalRecord, document: NotebookDocument) {
  const cell = findGoalCell(document, goal);
  const text = cell ? legacyGoalText(cell) : { title: null, brief: "" };
  return {
    kind: "video-goal" as const, legacy: true as const,
    goalId: goal.goalId, bookId: goal.bookId, notebookId: goal.notebookId, cellId: goal.cellId, planVersion: goal.planVersion,
    address: cell ? notebookGridTag(cell.slot) : null, title: text.title, brief: text.brief,
    status: goal.status, error: goal.error, outputs: legacyOutputs(engine, goal, document),
    finalArtifactId: goal.finish?.finalArtifactId ?? (goal.combined?.status === "completed" ? goal.combined.artifactId : null),
    dismissedAt: goal.dismissedAt, createdAt: goal.createdAt, updatedAt: goal.updatedAt,
  };
}

async function shortGoalSnapshot(engine: Engine, goal: GoalRecord, document: NotebookDocument) {
  const cell = findGoalCell(document, goal);
  const short = cell ? goalShortContent(cell) : null;
  const content = short
    ? { brief: short.brief, revision: short.revision, estimate: short.estimate, notes: short.notes }
    : { brief: "", revision: 0, estimate: emptyGoalEstimates(), notes: [] };
  const stages = Object.fromEntries(Object.entries(goal.stages).map(([stage, run]) => [stage, {
    ...run,
    ...(stage === "videos" ? { attempts: goalStageAttempts(goal, "videos") } : {}),
    outputs: run.outputs.map(output => {
      const outputCell = document.cells.find(candidate => candidate.id === output.cellId);
      const versions = goalStageAttempts(goal, stage as GoalGenerationStage).filter(attempt => attempt.index === output.index).slice().reverse().map(attempt => {
        const versionCell = document.cells.find(candidate => candidate.id === attempt.cellId);
        const step = getChainRun(engine, attempt.chainId)?.steps.find(candidate => candidate.id === attempt.stepId);
        return {
          ...attempt, address: versionCell ? notebookGridTag(versionCell.slot) : null,
          status: step?.status ?? "interrupted" as const, current: attempt.artifactId === output.artifactId,
        };
      });
      const stale = stage === "videos" && shortSegmentStale(goal, output.index) ? SHORT_STALE_MESSAGE : null;
      return { ...output, address: outputCell ? notebookGridTag(outputCell.slot) : null, versions, stale, realism: goal.realism?.[output.artifactId] ?? null };
    }),
    steps: goalChainSteps(engine, document, run.chainId),
    allSteps: [...run.previousChainIds, run.chainId].flatMap(chainId => allGoalChainSteps(engine, document, chainId)),
  }] satisfies [string, unknown]));
  return {
    kind: "video-goal" as const, legacy: false as const, ...goal, ...content,
    ...(short?.plan ? { shortPlan: refreshGoalShortPlan(short.plan, document), mainCharacterReferences: readMainCharacter(engine).referenceArtifactIds.length } : {}),
    finish: goal.finish ?? null,
    finalArtifactId: goal.finish?.finalArtifactId ?? null,
    coldOpen: null,
    address: cell ? notebookGridTag(cell.slot) : null,
    stages: stages as Partial<Record<GoalGenerationStage, NonNullable<typeof stages[string]>>>,
    steps: goalChainSteps(engine, document, goal.chainId),
  };
}

export async function publicGoal(engine: Engine, goal: GoalRecord, document: NotebookDocument) {
  return goal.planVersion === 4 ? shortGoalSnapshot(engine, goal, document) : legacyGoalSnapshot(engine, goal, document);
}
