import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { cancelChainRun, getChainRun, type ChainRunRecord } from "./chain-executor.js";
import { emptyGoalEstimates, findGoalCell, goalContent, requireGoalContent, saveGoal, writeGoalContent, type GoalRecord, type GoalStageOutput } from "./goal-store.js";
import { GOAL_VIDEO_TOOL, type GoalGenerationStage } from "./goal-plan.js";
import { mutateNotebook } from "./notebook-mutations.js";
import { goalStillStaleReason } from "./goal-stills.js";

export const LEGACY_GOAL_MESSAGE = "Goal mode now starts from character images. Start a new /goal.";

export function activeGoalStage(goal: GoalRecord): GoalGenerationStage {
  return goal.stage === "assembly" ? "videos" : goal.stage;
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
      id: step.id, status: step.status, error: step.error,
      artifactId: outputString(step.outputs, "asset_id") ?? outputString(step.outputs, "img_asset_id") ?? outputString(step.outputs, "vid_asset_id"),
      cellId: producer?.id ?? null,
      address: producer ? notebookGridTag(producer.slot) : outputString(step.outputs, "address"),
      outputCellId: outputString(step.outputs, "cell_id"), startedAt: step.startedAt ?? null,
    };
  }) ?? [];
}

function completedStageOutputs(engine: Engine, goal: GoalRecord, document: NotebookDocument): GoalStageOutput[] {
  return goalChainSteps(engine, document, goal.chainId).flatMap(step => {
    if (step.status !== "completed" || !step.artifactId || step.id === "assemble") return [];
    const index = step.id === "frame" ? 0 : Number(/\d+$/u.exec(step.id)?.[0]) - 1;
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

export async function writeGoalCombinationState(engine: Engine, goal: GoalRecord, error: string | null): Promise<GoalRecord> {
  if (!goal.combined) return goal;
  const updated = await mutateNotebook(engine, goal.notebookId, "goal_combine_complete", document => ({
    ...document, cells: document.cells.map(cell => cell.id === goal.combined?.cellId ? { ...cell, inputs: { ...cell.inputs, state: error ? "error" : "completed" } } : cell),
  }));
  if (!updated.ok) throw new Error(updated.error.message);
  return saveGoal(engine, { ...goal, combined: { ...goal.combined, status: error ? "failed" : "completed", error } });
}

export async function reconcileGoal(engine: Engine, goal: GoalRecord, document: NotebookDocument): Promise<GoalRecord> {
  if (goal.planVersion === 1) {
    if (!["planning", "review", "running"].includes(goal.status)) return goal;
    if (goal.chainId) cancelChainRun(engine, goal.chainId);
    if (goal.planningJobId) await engine.jobs.queue.abort(goal.planningJobId, LEGACY_GOAL_MESSAGE);
    return saveGoal(engine, { ...goal, status: "failed", error: LEGACY_GOAL_MESSAGE });
  }
  if (goal.combined?.status === "running") {
    const job = goal.combined.jobId ? engine.jobs.queue.get(goal.combined.jobId) : null;
    if (!job || ["failed", "aborted"].includes(job.state)) goal = await writeGoalCombinationState(engine, goal, job?.error?.message ?? "Combining was interrupted. Retry the combined video.");
  }
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
  if (stage === "videos" && goal.assembly) {
    next = { ...next, status: "completed", error: null };
  } else if (chain.status === "completed") {
    const content = requireGoalContent(engine, goal);
    const shotCount = content.plan?.shots.length ?? 0;
    const expected = stage === "frame" ? 1 : stage === "storyboards" && content.plan && "frameContinuity" in content.plan && content.plan.frameContinuity ? 2 * shotCount : shotCount;
    if (outputs.length !== expected) next = { ...next, status: "failed", error: "The stage finished without all of its media outputs. Retry the stage." };
    else if (stage === "videos") next = { ...next, status: goal.assembly || expected === 1 ? "completed" : "failed", error: goal.assembly || expected === 1 ? null : "The finished clips still need to be assembled" };
    else {
      await writeGoalContent(engine, goal, { ...content, revision: content.revision + 1 });
      next = { ...next, stage: stage === "frame" ? "storyboards" : "videos", status: "review", error: null };
    }
  } else if (["failed", "interrupted", "cancelled"].includes(chain.status)) {
    next = { ...next, status: chain.status as "failed" | "interrupted" | "cancelled", error: chain.error };
  } else {
    next = { ...next, stage: chain.steps.some(step => step.id === "assemble" && step.status === "running") ? "assembly" : stage, status: "running", error: null };
  }
  return JSON.stringify(next) === JSON.stringify(goal) ? goal : saveGoal(engine, next);
}

export function publicGoal(engine: Engine, goal: GoalRecord, document: NotebookDocument) {
  const cell = findGoalCell(document, goal);
  const content = cell ? goalContent(cell) : { brief: "", characters: [], revision: 0, plan: null, estimate: emptyGoalEstimates() };
  const stages = Object.fromEntries(Object.entries(goal.stages).map(([stage, run]) => [stage, {
    ...run,
    outputs: run.outputs.map(output => {
      const outputCell = document.cells.find(candidate => candidate.id === output.cellId);
      const versions = (run.attempts ?? []).filter(attempt => attempt.index === output.index).slice().reverse().map(attempt => {
        const versionCell = document.cells.find(candidate => candidate.id === attempt.cellId);
        const step = getChainRun(engine, attempt.chainId)?.steps.find(candidate => candidate.id === attempt.stepId);
        return {
          ...attempt, address: versionCell ? notebookGridTag(versionCell.slot) : null,
          status: step?.status ?? "interrupted" as const, current: attempt.artifactId === output.artifactId,
        };
      });
      const stale = content.plan && "version" in content.plan && (stage === "frame" || stage === "storyboards")
        ? goalStillStaleReason(engine, goal, document, content.plan, content.characters, stage, output) : null;
      return { ...output, address: outputCell ? notebookGridTag(outputCell.slot) : null, versions, stale };
    }),
    steps: goalChainSteps(engine, document, run.chainId),
    allSteps: [...run.previousChainIds, run.chainId].flatMap(chainId => allGoalChainSteps(engine, document, chainId)),
  }]));
  return {
    kind: "video-goal" as const, ...goal, ...content,
    address: cell ? notebookGridTag(cell.slot) : null,
    stages: stages as Partial<Record<GoalGenerationStage, NonNullable<typeof stages[string]>>>,
    steps: goalChainSteps(engine, document, goal.chainId),
  };
}

export function completedGoalVideos(engine: Engine, goal: GoalRecord): string[] {
  const chainId = goal.stages.videos?.chainId ?? (goal.planVersion === 1 ? goal.chainId : null);
  return (chainId ? getChainRun(engine, chainId)?.steps ?? [] : []).flatMap(step => {
    const id = outputString(step.outputs, "asset_id") ?? outputString(step.outputs, "vid_asset_id");
    return step.tool === GOAL_VIDEO_TOOL && step.status === "completed" && id ? [id] : [];
  });
}
