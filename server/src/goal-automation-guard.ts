import type { Engine } from "videobook-engine";
import { analysisComponentKey } from "./analysis-components.js";
import { goalAutomationTotals } from "./goal-automation-model.js";
import { goalGenerationHistory, goalHistoryFailure } from "./goal-generation-history.js";
import type { GoalGenerationOrigin } from "./goal-generation-provenance.js";
import { shortStageProposal } from "./goal-short-runtime.js";
import { findGoalCell, readGoal, requireGoalShortContent, saveGoal, type GoalEstimate, type GoalRecord } from "./goal-store.js";
import { resolveModel } from "./media/descriptor.js";
import { withNotebookMutation } from "./notebook-mutations.js";

export function goalAutomationPlanKey(engine: Engine, goal: GoalRecord): string {
  const { plan, brief } = requireGoalShortContent(engine, goal);
  return analysisComponentKey({ component: "goal-automation", version: 1, jobType: "continue_goal" }, { sourceHash: brief, options: { plan } });
}

export function assertAutomaticEstimate(estimate: GoalEstimate): number {
  if (estimate.usd === null || !Number.isFinite(estimate.usd) || estimate.usd < 0
    || estimate.warnings.some(warning => /lower[ -]bound|unknown|unavailable|unbounded|additional|not included|excludes|partial|missing/iu.test(warning))) {
    throw new Error(`Automatic continuation needs a complete next-step estimate. ${estimate.warnings.join(" ")} Review and submit this step manually if its price remains uncertain.`);
  }
  return estimate.usd;
}

export async function assertGoalAccountReady(engine: Engine, goal: GoalRecord, modelId: string): Promise<void> {
  const provider = resolveModel(modelId).provider;
  const history = await goalGenerationHistory(engine, goal.notebookId, { goalId: goal.goalId, related: true });
  const latest = history.filter(entry => {
    try { return entry.actualModel && resolveModel(entry.actualModel).provider === provider && (entry.status === "completed" || entry.error); }
    catch { return false; }
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (latest && goalHistoryFailure(latest.error) === "account" && latest.createdAt > (goal.automation?.accountReviewedAt ?? "")) {
    throw new Error(`The latest ${provider} request has an unresolved account or balance failure. Resolve it and explicitly confirm the account is ready before resuming. ${latest.error}`);
  }
}

export async function guardGoalSubmission(engine: Engine, input: { goalOrigin?: GoalGenerationOrigin; assetId: string; runId?: string }, submit: boolean): Promise<void> {
  const origin = input.goalOrigin;
  if (!origin?.automation) return;
  await withNotebookMutation(`goal:${origin.goalId}`, async () => {
    const goal = readGoal(engine, origin.goalId);
    const automation = goal.automation;
    const notebook = engine.notebooks.read(goal.notebookId);
    if (!automation || automation.id !== origin.automation!.id || automation.status !== "running" || goal.status === "cancelled"
      || !notebook.ok || !findGoalCell(notebook.value, goal)) throw new Error("Automatic continuation stopped before submission.");
    if (automation.planKey !== goalAutomationPlanKey(engine, goal)) throw new Error("The approved recipe changed before submission. Review it and resume explicitly.");
    const reservation = automation.reservations.find(value => value.id === origin.automation!.reservationId);
    if (!reservation || reservation.status !== "reserved" || reservation.submittedArtifactIds.length || origin.fingerprint !== reservation.inputKey) {
      throw new Error("This automatic submission has already started or has no current reservation. Recover its existing provider task; do not submit again.");
    }
    const proposal = await shortStageProposal(engine, goal, origin.stage, origin.index);
    if (proposal.inputKey !== reservation.inputKey) throw new Error("The approved generation inputs changed before submission.");
    await assertGoalAccountReady(engine, goal, String(proposal.step.params.model));
    const price = assertAutomaticEstimate(proposal.estimate);
    const totals = goalAutomationTotals(automation);
    if (price > reservation.amountUsd + 0.0000001 || totals.spent + totals.reserved > automation.allowanceUsd + 0.0000001) {
      throw new Error("The fresh estimate no longer fits the approved continuation allowance. Review it before submitting.");
    }
    if (submit) saveGoal(engine, { ...goal, automation: { ...automation, reservations: automation.reservations.map(value => value.id !== reservation.id ? value : {
      ...value, status: "submitted", submittedArtifactIds: [input.assetId],
      runIds: input.runId ? [...new Set([...value.runIds, input.runId])] : value.runIds,
      chainId: value.chainId ?? input.runId?.split(":")[0] ?? null,
    }) } });
  });
}
