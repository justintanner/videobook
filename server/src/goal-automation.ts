import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine } from "videobook-engine";
import { getChainRun, recoverAutomaticChainOutput } from "./chain-executor.js";
import { captionMediaSource } from "./captions/source.js";
import { probeVideo } from "./ffmpeg.js";
import { approvedInThisLibrary, assertApprovedInThisLibrary, assertAutomaticEstimate, assertGoalAccountReady, goalAutomationPlanKey, IMPORTED_GOAL_REASON } from "./goal-automation-guard.js";
import { bookImportId } from "./book-import.js";
import { goalAutomationTotals, type GoalAutomation, type GoalReservation } from "./goal-automation-model.js";
import { reviewedGoalOutput } from "./goal-generation-history.js";
import { makeGoalQualityRequest, readGoalQualityResult, reconcileGoalQuality } from "./goal-quality.js";
import { goalQualityAccepted } from "./goal-quality-model.js";
import { goalReferenceHashes } from "./goal-reference-images.js";
import { shortGenerationSegments, shortStoryboardOf } from "./goal-short-plan.js";
import { assertRemixPreflight, nextShortSegment, reviewedShortCandidates, selectShortVersion, shortStageProposal, startShortStage } from "./goal-short-runtime.js";
import { reconcileFinish, reconcileGoal } from "./goal-state.js";
import { activeGoalStage, findGoalCell, listGoals, readGoal, requireGoalShortContent, saveGoal, type GoalRecord } from "./goal-store.js";
import { queueGoalFinish } from "./jobs/finish-goal.js";
import { withNotebookMutation } from "./notebook-mutations.js";
import { queue } from "./queue.js";

const ACTIVE_JOBS = ["queued", "running", "completing"];

function saveAutomation(engine: Engine, goal: GoalRecord, changes: Partial<GoalAutomation>): GoalRecord {
  if (!goal.automation) throw new Error("This goal has no automatic run.");
  return saveGoal(engine, { ...goal, automation: { ...goal.automation, ...changes } });
}

export function pauseGoalAutomation(engine: Engine, goal: GoalRecord, reason = "Paused by you. Current provider work remains available."): GoalRecord {
  return goal.automation ? saveAutomation(engine, goal, { status: "paused", reason, jobId: null }) : goal;
}

function reconcileReservations(engine: Engine, goal: GoalRecord): GoalRecord {
  const reservations = goal.automation!.reservations.map((value): GoalReservation => {
    if (["settled", "released"].includes(value.status)) return value;
    const chain = value.chainId ? getChainRun(engine, value.chainId) : null;
    const runIds = [...new Set([...value.runIds, ...chain?.steps.map(step => `${chain.chainId}:${step.id}`) ?? []])];
    const totals = runIds.map(runId => engine.usage.rollup({ runId }).totals);
    const rows = engine.usage.recent(200).filter(row => row.runId && runIds.includes(row.runId));
    const cost = totals.reduce((sum, row) => sum + row.actualUsd, 0);
    const count = totals.reduce((sum, row) => sum + row.count, 0);
    const unsettled = totals.reduce((sum, row) => sum + row.unsettled, 0);
    const stopped = chain && ["completed", "failed", "cancelled", "interrupted"].includes(chain.status);
    const status = count > 0 && unsettled === 0 && stopped ? "settled"
      : stopped && value.submittedArtifactIds.length === 0 ? "released"
      : stopped ? "uncertain" : value.status;
    return { ...value, status, runIds, usageIds: [...new Set([...value.usageIds, ...rows.map(row => row.id)])], spentUsd: count > 0 ? cost : value.spentUsd };
  });
  return JSON.stringify(reservations) === JSON.stringify(goal.automation!.reservations) ? goal : saveAutomation(engine, goal, { reservations });
}

async function selectedHashes(engine: Engine, goal: GoalRecord, stages: ("replacement" | "frame" | "videos")[]) {
  const ids = stages.flatMap(stage => goal.stages[stage]?.outputs.map(output => output.artifactId) ?? []);
  return (await goalReferenceHashes(engine, ids)).flatMap(value => value.objectHash ? [{ artifactId: value.artifactId, mediaHash: value.objectHash }] : []);
}

async function approvedSelection(engine: Engine, goal: GoalRecord, stages: ("replacement" | "frame" | "videos")[], value: unknown, previous: GoalAutomation["approvedImages"]) {
  const current = await selectedHashes(engine, goal, stages);
  const receipts = z.array(z.object({ artifact_id: z.string().uuid(), media_hash: z.string().min(1) }).strict()).parse(value ?? []);
  const matches = (artifactId: string, mediaHash: string) => current.some(item => item.artifactId === artifactId && item.mediaHash === mediaHash);
  if (receipts.some(item => !matches(item.artifact_id, item.media_hash))) throw new Error("A reviewed output changed or is no longer selected. Review its current media hash before continuing.");
  return [...previous.filter(item => matches(item.artifactId, item.mediaHash)), ...receipts.map(item => ({ artifactId: item.artifact_id, mediaHash: item.media_hash }))]
    .filter((item, index, all) => all.findIndex(other => other.artifactId === item.artifactId && other.mediaHash === item.mediaHash) === index);
}

export async function startGoalAutomation(engine: Engine, goal: GoalRecord, args: Record<string, unknown>): Promise<GoalRecord> {
  const content = requireGoalShortContent(engine, goal);
  if (content.revision !== args.revision) throw new Error("The goal changed. Review its current revision before continuing.");
  const plan = content.plan;
  if (plan?.version !== 5 || !plan.analysis || shortStoryboardOf(plan)) throw new Error("Automatic continuation requires a current analyzed short. Saved storyboard goals keep their stage reviews.");
  if (goal.automation?.status === "running" && approvedInThisLibrary(engine, goal.automation)) return goal;
  if (!["review", "completed"].includes(goal.status) || goal.finish?.status === "running") throw new Error("Wait for current work or recover the existing attempt before resuming. Failed creative requests need an explicit manual retry.");
  if (args.confirmed !== true) throw new Error("Confirm the saved recipe and any selected images were reviewed before starting automatic continuation.");
  const allowance = args.allowance_usd ?? goal.automation?.allowanceUsd ?? plan.analysis.preferences.allowanceUsd;
  if (typeof allowance !== "number" || !Number.isFinite(allowance) || allowance < 0) throw new Error("Set an explicit USD continuation allowance, including zero for local-only work.");
  await assertRemixPreflight(engine, plan);
  const unresolved = plan.analysis.findings.filter(finding => finding.severity === "review" && ["missing-audio", "finish-branding"].includes(finding.code));
  if (unresolved.length) throw new Error(unresolved.map(finding => finding.text).join(" "));
  const approvedImages = await approvedSelection(engine, goal, ["replacement", "frame"], args.reviewed_images, goal.automation?.approvedImages ?? []);
  const approvedAudio = await approvedSelection(engine, goal, ["videos"], args.reviewed_audio, goal.automation?.approvedAudio ?? []);
  const automation: GoalAutomation = { version: 1, id: goal.automation?.id ?? uuidv7(), status: "running", planKey: goalAutomationPlanKey(engine, goal), allowanceUsd: allowance,
    approvedAt: new Date().toISOString(), approvedImportId: bookImportId(engine), approvedImages, approvedAudio, accountReviewedAt: args.account_reviewed === true ? new Date().toISOString() : goal.automation?.accountReviewedAt ?? null,
    step: "Check approved recipe", reason: null, jobId: null, reservations: goal.automation?.reservations ?? [] };
  return enqueueContinuation(engine, saveGoal(engine, { ...goal, automation }));
}

async function enqueueContinuation(engine: Engine, goal: GoalRecord): Promise<GoalRecord> {
  const automation = goal.automation!;
  const job = await queue.enqueue(`goal-continue-${goal.goalId}-${uuidv7()}`, { type: "continue_goal", bookId: goal.bookId, goalId: goal.goalId, automationId: automation.id, planKey: automation.planKey });
  return saveAutomation(engine, goal, { jobId: job.id });
}

async function requireOutputChecks(engine: Engine, goal: GoalRecord): Promise<string | null> {
  const plan = requireGoalShortContent(engine, goal).plan!;
  if (plan.version !== 5 || !plan.analysis) throw new Error("Analyze the current recipe before continuing.");
  const { preferences, intent } = plan.analysis;
  const stages = ["replacement", "frame", "videos"] as const;
  const slots = stages.flatMap(stage => (goal.stages[stage]?.outputs ?? []).map(output => ({ stage, index: output.index, artifactId: output.artifactId })));
  const final = goal.finish?.finalArtifactId;
  const checks = [...slots, ...(final ? [{ stage: "finish" as const, index: 0, artifactId: final }] : [])];
  for (const slot of checks) {
    const request = await makeGoalQualityRequest(engine, goal, slot.stage, slot.index, false);
    const check = goal.quality?.[request.slot];
    if (!check || check.key !== request.key || check.status === "running") return "Checking current outputs";
    const result = readGoalQualityResult(engine, request.key) ?? check.result;
    if (!goalQualityAccepted(result, preferences.semanticChecks)) throw new Error(check.error ?? ([...result?.technical.findings ?? [], ...result?.semantic.findings ?? []]
      .filter(value => value.severity !== "note").map(value => value.text).join(" ") || "Review this output against the brief. A required visual check is missing, failed or unverified; its complete price is unknown, so request it explicitly."));
    if ((slot.stage === "frame" || slot.stage === "replacement") && preferences.reviewImages) {
      const review = reviewedGoalOutput(goal, slot.stage, slot.index, slot.artifactId);
      const approved = review?.mediaHash === request.mediaHash || goal.automation!.approvedImages.some(value => value.artifactId === slot.artifactId && value.mediaHash === request.mediaHash);
      if (!approved) throw new Error(`Review the ${slot.stage === "replacement" ? "replacement" : "action setup"} image, then resume with the selected images approved.`);
    }
    if (slot.stage === "videos" && intent.noDialogue && ["generated", "mix"].includes(intent.audio)
      && !goal.automation!.approvedAudio.some(value => value.artifactId === slot.artifactId && value.mediaHash === request.mediaHash)) {
      const source = await captionMediaSource(engine, slot.artifactId);
      if ((await probeVideo(source.path)).hasAudio) throw new Error("Listen to the generated audio and confirm it contains no new dialogue before resuming. Sampled visual checks do not listen to speech.");
    }
  }
  return null;
}

async function advance(engine: Engine, goal: GoalRecord): Promise<GoalRecord> {
  assertApprovedInThisLibrary(engine, goal.automation!);
  goal = reconcileReservations(engine, goal);
  const automation = goal.automation!;
  if (automation.planKey !== goalAutomationPlanKey(engine, goal)) throw new Error("The approved recipe changed. Review it and resume explicitly.");
  if (["failed", "interrupted", "cancelled"].includes(goal.status)) throw new Error(goal.error ?? "The current attempt stopped. Recover it or explicitly retry the affected stage; automatic creative retries are disabled.");
  if (goal.finish?.status === "failed" || goal.finish?.status === "cancelled") throw new Error(goal.finish.error ?? "Finishing stopped. Review and retry the existing finish explicitly.");
  const content = requireGoalShortContent(engine, goal);
  const plan = content.plan!;
  await assertRemixPreflight(engine, plan);
  goal = await reconcileGoalQuality(engine, goal);
  const waiting = await requireOutputChecks(engine, goal);
  if (waiting) return saveAutomation(engine, goal, { step: waiting, jobId: null });
  const totals = goalAutomationTotals(automation);
  if (totals.unsettled) throw new Error("The previous provider cost is still unsettled. Recover its existing task or verify billing before another automatic step; its reservation remains held.");
  if (totals.spent > automation.allowanceUsd + 0.0000001) throw new Error("Recorded provider cost exceeds the continuation allowance. Review the bill and increase the allowance explicitly to continue.");
  if (automation.reservations.some(value => value.status === "reserved")) throw new Error("A reserved step has no confirmed submission outcome. Recover the existing attempt before continuing; it will not be resubmitted automatically.");
  if (goal.finish?.status === "completed") return saveAutomation(engine, goal, { status: "completed", step: "Final preview ready", reason: null, jobId: null });
  if (nextShortSegment(goal, plan) === null && goal.stages.videos?.outputs.length === shortGenerationSegments(plan).length) {
    goal = saveAutomation(engine, goal, { step: "Assemble sound and branding", jobId: null });
    return queueGoalFinish(engine, goal);
  }
  const stage = activeGoalStage(goal);
  const index = stage === "videos" ? nextShortSegment(goal, plan) ?? 0 : 0;
  const reusable = (await reviewedShortCandidates(engine, goal, plan)).find(entry => entry.stage === stage && entry.index === index);
  if (reusable) {
    goal = await selectShortVersion(engine, goal, { action: "adopt", revision: content.revision, stage, index, artifact_id: reusable.artifactId, media_hash: reusable.mediaHash, confirmed: true });
    return saveAutomation(engine, goal, { step: `Reused reviewed ${stage} image`, jobId: null });
  }
  const proposal = await shortStageProposal(engine, goal, stage, index);
  await assertGoalAccountReady(engine, goal, String(proposal.step.params.model));
  const amountUsd = assertAutomaticEstimate(proposal.estimate);
  if (amountUsd > totals.remaining + 0.0000001) throw new Error(`The next ${stage} estimate ($${amountUsd.toFixed(4)}) exceeds the remaining allowance ($${totals.remaining.toFixed(4)}). Increase the allowance explicitly or continue manually.`);
  const reservation: GoalReservation = { id: uuidv7(), stage, index, inputKey: proposal.inputKey, amountUsd, warnings: proposal.estimate.warnings,
    status: "reserved", chainId: null, runIds: [], usageIds: [], spentUsd: null, submittedArtifactIds: [], createdAt: new Date().toISOString() };
  goal = saveAutomation(engine, goal, { reservations: [...automation.reservations, reservation], step: `Generate ${stage}${stage === "videos" ? ` ${index + 1}` : ""}`, jobId: null });
  goal = await startShortStage(engine, goal, { action: "approve", revision: content.revision, stage, automation_id: automation.id, reservation_id: reservation.id }, false);
  return saveAutomation(engine, goal, { reservations: goal.automation!.reservations.map(value => value.id === reservation.id ? {
    ...value, chainId: goal.chainId, runIds: goal.chainId ? [`${goal.chainId}:${proposal.step.id}`] : [],
    status: goal.chainId ? value.status : "released",
  } : value) });
}

export async function runGoalContinuation(engine: Engine, input: { goalId: string; automationId: string; planKey: string }, jobId: number): Promise<void> {
  await withNotebookMutation(`goal:${input.goalId}`, async () => {
    let goal = readGoal(engine, input.goalId);
    if (goal.automation?.status !== "running" || goal.automation.id !== input.automationId || goal.automation.planKey !== input.planKey || goal.automation.jobId !== jobId) return;
    try {
      const notebook = engine.notebooks.read(goal.notebookId);
      if (!notebook.ok || !findGoalCell(notebook.value, goal)) throw new Error("The goal was removed. Automatic continuation stopped.");
      if (goal.chainId && await recoverAutomaticChainOutput(engine, goal.chainId)) return;
      goal = await reconcileGoal(engine, reconcileFinish(engine, goal), notebook.value);
      if (goal.status === "running" || goal.finish?.status === "running") return;
      await advance(engine, goal);
    } catch (error) {
      pauseGoalAutomation(engine, readGoal(engine, input.goalId), error instanceof Error ? error.message : String(error));
    }
  });
}

export async function sweepGoalAutomation(engine: Engine): Promise<void> {
  for (const stored of listGoals(engine).filter(goal => goal.automation?.status === "running")) {
    await withNotebookMutation(`goal:${stored.goalId}`, async () => {
      let goal = readGoal(engine, stored.goalId);
      if (goal.automation?.status !== "running") return;
      if (!approvedInThisLibrary(engine, goal.automation)) {
        pauseGoalAutomation(engine, goal, IMPORTED_GOAL_REASON);
        return;
      }
      const active = goal.automation.jobId ? engine.jobs.queue.get(goal.automation.jobId) : null;
      if (active && ACTIVE_JOBS.includes(active.state)) return;
      try {
        const notebook = engine.notebooks.read(goal.notebookId);
        if (!notebook.ok || !findGoalCell(notebook.value, goal)) throw new Error("The goal was removed. Automatic continuation stopped.");
        if (goal.chainId && await recoverAutomaticChainOutput(engine, goal.chainId)) return;
        goal = reconcileReservations(engine, await reconcileGoal(engine, reconcileFinish(engine, goal), notebook.value));
        if (goal.status === "running" || goal.finish?.status === "running" || Object.values(goal.quality ?? {}).some(check => check.status === "running")) return;
        await enqueueContinuation(engine, goal);
      } catch (error) { pauseGoalAutomation(engine, readGoal(engine, stored.goalId), error instanceof Error ? error.message : String(error)); }
    });
  }
}
