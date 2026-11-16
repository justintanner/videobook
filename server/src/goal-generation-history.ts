import type { Engine, Generation, NotebookCell, NotebookDocument } from "videobook-engine";
import { resolveNotebookCellArtifactId } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { getChainRun } from "./chain-executor.js";
import { cellGoalOrigin, goalGenerationLineageSchema, type GoalGenerationLineage, type GoalGenerationOrigin } from "./goal-generation-provenance.js";
import { goalReferenceHashes } from "./goal-reference-images.js";
import { listGoals, requireGoalShortContent, type GoalGenerationStage, type GoalOutputReview, type GoalRecord, type GoalStillAttempt } from "./goal-store.js";
import { shortRemixOf } from "./goal-short-plan.js";
import { readProviderTaskStatus } from "./provider-task-status.js";

export type GoalHistoryEntry = GoalStillAttempt & {
  originGoalId: string;
  generationId?: string;
  revision: number | null;
  producerCellId: string | null;
  mediaHash: string | null;
  address: string | null;
  status: string;
  error: string | null;
  prompt: string;
  actualModel: string | null;
  lineage: GoalGenerationLineage | null;
  references: GoalGenerationLineage["references"];
  source: GoalGenerationOrigin["source"];
  review: GoalOutputReview | null;
  selected: boolean;
  usageIds: string[];
  costUsd: number | null;
  estimateUsd: number | null;
};

export function reviewedGoalOutput(goal: GoalRecord, stage: GoalGenerationStage, index: number, artifactId: string | undefined): GoalOutputReview | undefined {
  return goal.reviewedOutputs?.slice().reverse().find(review => review.stage === stage && review.index === index && review.artifactId === artifactId);
}

function priorReview(goals: GoalRecord[], preferred: GoalRecord, attempt: Pick<GoalStillAttempt, "stage" | "index" | "fingerprint" | "basePrompt" | "frameArtifactId">, artifactId: string | null, mediaHash: string | null): GoalOutputReview | null {
  if (!artifactId || !mediaHash) return null;
  const explicit = reviewedGoalOutput(preferred, attempt.stage, attempt.index, artifactId)
    ?? goals.flatMap(goal => goal.reviewedOutputs ?? []).filter(review => review.stage === attempt.stage && review.index === attempt.index && review.artifactId === artifactId)
      .sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))[0];
  if (explicit) return explicit;
  if (!attempt.fingerprint || attempt.stage === "videos") return null;
  const downstream = Object.values(preferred.stages).flatMap(run => run?.attempts ?? []).find(value => value.frameArtifactId === artifactId
    && fingerprintReferences(value.fingerprint).some(reference => reference.artifactId === artifactId && reference.objectHash === mediaHash));
  return downstream ? { stage: attempt.stage, index: attempt.index, artifactId, mediaHash, fingerprint: attempt.fingerprint, basePrompt: attempt.basePrompt,
    frameArtifactId: attempt.frameArtifactId, originGoalId: preferred.goalId, reviewedAt: downstream.createdAt } : null;
}

export function goalHistoryFailure(message: string | null): "account" | "request" | "transport" | "quality" | "unknown" | null {
  if (!message) return null;
  if (/\b(?:401|403|balance|credits?|unauthori[sz]ed|quota)\b/iu.test(message)) return "account";
  if (/\b(?:400|422|invalid|validation|required|reference)\b/iu.test(message)) return "request";
  if (/\b(?:network|timeout|timed out|ECONNRESET|download|poll)\b/iu.test(message)) return "transport";
  if (/\b(?:content policy|moderation|refusal|quality)\b/iu.test(message)) return "quality";
  return "unknown";
}

function sourceOf(engine: Engine, goal: GoalRecord): { artifactId: string; mediaHash: string | null } | null {
  try {
    const plan = requireGoalShortContent(engine, goal).plan;
    const source = plan?.version === 5 ? plan.analysis?.source : null;
    const artifactId = source?.artifactId ?? shortRemixOf(plan)?.video.artifactId;
    const earlier = artifactId ? Object.values(goal.stages).flatMap(run => run?.attempts ?? [])
      .flatMap(attempt => fingerprintReferences(attempt.fingerprint)).find(reference => reference.artifactId === artifactId)?.objectHash : null;
    return artifactId ? { artifactId, mediaHash: source?.mediaHash ?? earlier ?? null } : null;
  } catch { return null; }
}

export function resolveCellGoalOrigin(engine: Engine, notebookId: string, cell: NotebookCell): GoalGenerationOrigin | undefined {
  const saved = cellGoalOrigin(cell);
  if (saved) {
    const { automation: _automation, ...manual } = saved;
    return manual;
  }
  if (typeof cell.inputs?.chainRunId !== "string") return undefined;
  for (const goal of listGoals(engine, notebookId)) for (const run of Object.values(goal.stages)) {
    const attempt = run?.attempts?.find(value => value.chainId && cell.inputs?.chainRunId === `${value.chainId}:${value.stepId}`);
    if (!attempt?.chainId) continue;
    const origin = getChainRun(engine, attempt.chainId)?.goalOrigins?.[attempt.stepId];
    if (origin) {
      const { automation: _automation, ...manual } = origin;
      return manual;
    }
    const source = sourceOf(engine, goal);
    return { version: 1, goalId: goal.goalId, stage: attempt.stage, index: attempt.index,
      revision: run?.chainId === attempt.chainId ? run.revision : null, fingerprint: attempt.fingerprint ?? "", basePrompt: attempt.basePrompt,
      frameArtifactId: attempt.frameArtifactId, source: source?.mediaHash ? { artifactId: source.artifactId, mediaHash: source.mediaHash } : null,
      ...(attempt.stage === "videos" ? { transcribe: false } : {}),
    };
  }
  return undefined;
}

async function rowLineage(engine: Engine, artifactId: string | null): Promise<GoalGenerationLineage | null> {
  if (!artifactId) return null;
  const metadata = await engine.metadata.artifacts.read(artifactId, "goal-generation-lineage");
  const parsed = goalGenerationLineageSchema.safeParse(metadata.ok ? metadata.value : null);
  return parsed.success ? parsed.data : null;
}

async function recordedReferences(engine: Engine, artifactId: string | null, lineage: GoalGenerationLineage | null): Promise<GoalGenerationLineage["references"]> {
  if (lineage) return lineage.references;
  if (!artifactId) return [];
  const request = await engine.metadata.artifacts.read<{ refs?: Record<string, unknown>; fieldRefs?: Record<string, unknown> }>(artifactId, "generation-request");
  if (!request.ok) return [];
  const bindings = { ...request.value.refs, ...Object.fromEntries(Object.entries(request.value.fieldRefs ?? {}).map(([key, value]) => [`field:${key}`, value])) };
  return Object.entries(bindings).flatMap(([role, ids]) => Array.isArray(ids) ? ids.flatMap((artifactId: unknown, index: number) => typeof artifactId === "string" ? [{ role, index, artifactId, objectHash: null }] : []) : []);
}

function actualCell(document: NotebookDocument, artifactId: string | null, preferred: string | null) {
  const matches = document.cells.filter(cell => artifactId && resolveNotebookCellArtifactId(document, cell) === artifactId && ["image", "video"].includes(cell.type));
  return matches.find(cell => cell.id === preferred) ?? matches[0] ?? null;
}

export async function goalGenerationHistory(engine: Engine, notebookId: string, filter: { goalId?: string; sourceArtifactId?: string | null; related?: boolean } = {}): Promise<GoalHistoryEntry[]> {
  const read = engine.notebooks.read(notebookId);
  if (!read.ok) throw new Error(read.error.message);
  const document = read.value;
  const allGoals = listGoals(engine, notebookId);
  const requested = allGoals.find(goal => goal.goalId === filter.goalId);
  const sourceArtifactId = filter.sourceArtifactId ?? (requested ? sourceOf(engine, requested)?.artifactId : null);
  const goals = allGoals.filter(goal => goal.goalId === filter.goalId || ((filter.related || !filter.goalId) && sourceArtifactId && sourceOf(engine, goal)?.artifactId === sourceArtifactId));
  const goalMap = new Map(goals.map(goal => [goal.goalId, goal]));
  const attempts = goals.flatMap(goal => Object.values(goal.stages).flatMap(run => (run?.attempts ?? []).map(attempt => ({ goal, attempt }))));
  const rows: { row: Generation; origin: GoalGenerationOrigin | undefined; attempt?: GoalStillAttempt; goal: GoalRecord }[] = [];
  for (const cell of document.cells.filter(cell => cell.type === "generate_image" || cell.type === "generate_video")) {
    const origin = cellGoalOrigin(cell);
    const tagged = attempts.find(({ attempt }) => attempt.chainId && cell.inputs?.chainRunId === `${attempt.chainId}:${attempt.stepId}`);
    const goal = (origin ? goalMap.get(origin.goalId) : undefined) ?? tagged?.goal;
    if (!goal) continue;
    const listed = engine.generations.listForCell(notebookId, cell.id, { limit: 100 });
    if (!listed.ok) throw new Error(listed.error.message);
    for (const row of listed.value) {
      const attempt = attempts.find(item => item.goal.goalId === goal.goalId && (item.attempt.generationId === row.generationId
        || (row.providerArtifactId && item.attempt.artifactId === row.providerArtifactId)
        || (item.attempt.chainId && row.runId === `${item.attempt.chainId}:${item.attempt.stepId}`)))?.attempt;
      const associated = attempt ?? tagged?.attempt;
      rows.push({ row, origin, goal, ...(associated ? { attempt: associated } : {}) });
    }
  }
  const usage = engine.usage.recent(200);
  const result: GoalHistoryEntry[] = [];
  for (const item of rows.sort((a, b) => b.row.createdAt - a.row.createdAt).slice(0, 100)) {
    const { row, goal, attempt } = item;
    const artifactId = row.outputArtifactId ?? row.providerArtifactId ?? null;
    const lineage = await rowLineage(engine, row.providerArtifactId ?? artifactId);
    const origin = lineage?.origin ?? item.origin;
    if (!origin && !attempt) continue;
    const stage = origin?.stage ?? attempt!.stage;
    const index = origin?.index ?? attempt!.index;
    const fromChain = attempt?.chainId && row.runId === `${attempt.chainId}:${attempt.stepId}`;
    const cell = actualCell(document, artifactId, row.outputCellId ?? null);
    const [hash] = artifactId ? await goalReferenceHashes(engine, [artifactId]) : [];
    const calls = usage.filter(call => (call.artifactId && [artifactId, row.providerArtifactId].includes(call.artifactId))
      || (row.runId && call.runId === row.runId && call.cellId === row.cellId));
    const task = await readProviderTaskStatus(engine, row.providerArtifactId ?? artifactId, row);
    const linkedUsage = task?.provider && task.taskId ? engine.usage.find(task.provider, task.taskId) : null;
    if (linkedUsage && !calls.some(call => call.id === linkedUsage.id)) calls.push(linkedUsage);
    result.push({
      stage, index, chainId: fromChain ? attempt.chainId : null, stepId: fromChain ? attempt.stepId : row.generationId,
      artifactId, cellId: cell?.id ?? null, basePrompt: origin?.basePrompt ?? attempt?.basePrompt ?? row.prompt ?? "",
      ...(origin?.fingerprint ?? attempt?.fingerprint ? { fingerprint: origin?.fingerprint ?? attempt?.fingerprint } : {}),
      feedback: attempt?.feedback ?? null, parentArtifactId: attempt?.parentArtifactId ?? null,
      ...(attempt?.model ? { model: attempt.model } : {}),
      frameArtifactId: origin?.frameArtifactId ?? attempt?.frameArtifactId ?? null,
      createdAt: new Date(row.createdAt).toISOString(), generationId: row.generationId, originGoalId: origin?.goalId ?? goal.goalId,
      revision: origin?.revision ?? null, producerCellId: row.cellId, mediaHash: hash?.objectHash ?? null,
      address: cell ? notebookGridTag(cell.slot) : null, status: row.status, error: row.error ?? null,
      prompt: row.resolvedPrompt ?? row.prompt ?? "", actualModel: row.model ?? null, lineage, references: await recordedReferences(engine, row.providerArtifactId ?? artifactId, lineage),
      source: origin?.source ?? (sourceOf(engine, goal)?.mediaHash ? sourceOf(engine, goal) as GoalGenerationOrigin["source"] : null),
      review: priorReview(goals, requested ?? goal, { stage, index, fingerprint: origin?.fingerprint ?? attempt?.fingerprint,
        basePrompt: origin?.basePrompt ?? attempt?.basePrompt ?? "", frameArtifactId: origin?.frameArtifactId ?? attempt?.frameArtifactId ?? null }, artifactId, hash?.objectHash ?? null)
        ?? (requested && requested.goalId !== goal.goalId && attempt ? priorReview(goals, goal, attempt, artifactId, hash?.objectHash ?? null) : null),
      selected: Boolean(goal.stages[stage]?.outputs.some(output => output.index === index && output.artifactId === artifactId)),
      usageIds: calls.map(call => call.id),
      costUsd: calls.length && calls.every(call => call.costUsd !== null) ? calls.reduce((sum, call) => sum + call.costUsd!, 0) : null,
      estimateUsd: calls.length && calls.every(call => call.estimateUsd !== null) ? calls.reduce((sum, call) => sum + call.estimateUsd!, 0) : null,
    });
  }
  for (const { goal, attempt } of attempts.slice().reverse()) {
    if (result.some(entry => entry.generationId === attempt.generationId && attempt.generationId
      || entry.artifactId && entry.artifactId === attempt.artifactId
      || entry.chainId === attempt.chainId && entry.stepId === attempt.stepId && entry.originGoalId === goal.goalId)) continue;
    const step = attempt.chainId ? getChainRun(engine, attempt.chainId)?.steps.find(value => value.id === attempt.stepId) : null;
    const rawId = step?.outputs?.asset_id;
    const artifactId = attempt.artifactId ?? (typeof rawId === "string" ? rawId : null);
    const cell = actualCell(document, artifactId, attempt.cellId);
    const producer = document.cells.find(value => value.inputs?.chainRunId === `${attempt.chainId}:${attempt.stepId}`);
    const [hash] = artifactId ? await goalReferenceHashes(engine, [artifactId]) : [];
    const request = artifactId ? await engine.metadata.artifacts.read<{ prompt?: string; model?: string }>(artifactId, "generation-request") : null;
    const source = sourceOf(engine, goal);
    const lineage = await rowLineage(engine, artifactId);
    const calls = usage.filter(call => artifactId && call.artifactId === artifactId);
    const task = await readProviderTaskStatus(engine, artifactId);
    const linkedUsage = task?.provider && task.taskId ? engine.usage.find(task.provider, task.taskId) : null;
    if (linkedUsage && !calls.some(call => call.id === linkedUsage.id)) calls.push(linkedUsage);
    const requestReferences = await recordedReferences(engine, artifactId, lineage);
    result.push({ ...attempt, artifactId, cellId: cell?.id ?? null, originGoalId: attempt.originGoalId ?? goal.goalId,
      revision: null, producerCellId: producer?.id ?? null, mediaHash: hash?.objectHash ?? null,
      address: cell ? notebookGridTag(cell.slot) : null, status: step?.status ?? (hash?.objectHash ? "completed" : "interrupted"), error: step?.error ?? null,
      prompt: request?.ok ? request.value.prompt ?? attempt.basePrompt : typeof step?.params.prompt === "string" ? step.params.prompt : attempt.basePrompt,
      actualModel: request?.ok ? request.value.model ?? null : typeof step?.params.model === "string" ? step.params.model : attempt.model ?? null,
      lineage, references: requestReferences.length ? requestReferences : (step?.pins ?? []).map(pin => ({ role: pin.field, index: pin.index ?? 0, artifactId: pin.artifactId, objectHash: pin.objectHash })),
      source: source?.mediaHash ? { artifactId: source.artifactId, mediaHash: source.mediaHash } : null,
      review: priorReview(goals, goal, attempt, artifactId, hash?.objectHash ?? null),
      selected: Boolean(artifactId && goal.stages[attempt.stage]?.outputs.some(output => output.artifactId === artifactId)),
      usageIds: calls.map(call => call.id),
      costUsd: calls.length && calls.every(call => call.costUsd !== null) ? calls.reduce((sum, call) => sum + call.costUsd!, 0) : null,
      estimateUsd: calls.length && calls.every(call => call.estimateUsd !== null) ? calls.reduce((sum, call) => sum + call.estimateUsd!, 0) : null,
    });
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
}

export async function goalHistoryInputProblem(engine: Engine, entry: GoalHistoryEntry, source: GoalGenerationOrigin["source"]): Promise<string | null> {
  if (!entry.mediaHash || !entry.artifactId) return "This attempt has no playable output.";
  if (source && (!entry.source || source.artifactId !== entry.source.artifactId || source.mediaHash !== entry.source.mediaHash)) return "This take belongs to a different or unverified source version.";
  const references = entry.lineage?.references ?? fingerprintReferences(entry.fingerprint);
  const current = await goalReferenceHashes(engine, references.map(reference => reference.artifactId));
  if (references.some((reference, index) => !reference.objectHash || reference.objectHash !== current[index]?.objectHash)) return "A recorded generation input changed or cannot be verified. Restore the original input before adopting this take.";
  if (source) {
    const [hash] = await goalReferenceHashes(engine, [source.artifactId]);
    if (hash?.objectHash !== source.mediaHash) return "The source changed after initial analysis. Analyze it again before adopting a take.";
  }
  return null;
}

function fingerprintReferences(fingerprint: string | undefined): { artifactId: string; objectHash: string | null }[] {
  const found: { artifactId: string; objectHash: string | null }[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const object = value as Record<string, unknown>;
    if (typeof object.artifactId === "string" && "objectHash" in object) found.push({ artifactId: object.artifactId, objectHash: typeof object.objectHash === "string" ? object.objectHash : null });
    Object.values(object).forEach(visit);
  };
  try { if (fingerprint) visit(JSON.parse(fingerprint)); } catch { return []; }
  return found;
}
