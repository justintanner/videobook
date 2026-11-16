import { z } from "zod";
import type { Engine } from "videobook-engine";
import { requireGoalShortContent, saveGoal, writeGoalShortContent, type GoalRecord } from "./goal-store.js";
import { goalReferenceHashes } from "./goal-reference-images.js";
import { queue } from "./queue.js";
import { cleanupFrameCount, cleanupMethodSchema, cleanupRegionsSchema, validateCleanupRegions } from "./video-cleanup/model.js";
import { cleanupCandidate, cleanupContentKey, reviewCleanupCopy } from "./video-cleanup/prepared.js";
import { cleanupModelStatus } from "./video-cleanup/models.js";
import { readCleanupRequest, cleanupRenderStatus } from "./video-cleanup/service.js";

export const goalPreparationInputSchema = z.object({
  confirmed: z.literal(true), regions: cleanupRegionsSchema.optional(), method: cleanupMethodSchema.optional(),
  artifactId: z.string().uuid().optional(), mediaHash: z.string().min(1).optional(),
}).strict();

function preparationContent(engine: Engine, goal: GoalRecord, revision: unknown) {
  if (!["review", "completed", "failed", "interrupted"].includes(goal.status)) throw new Error("Stop the current work before preparing the source. Cancelled goals stay cancelled.");
  const content = requireGoalShortContent(engine, goal);
  if (content.revision !== revision) throw new Error("The goal changed. Review its current version first.");
  const plan = content.plan;
  if (plan?.version !== 5 || !plan.analysis?.source || !plan.remix) throw new Error("Analyze a source remix before preparing it.");
  return { content, plan, analysis: plan.analysis, source: plan.analysis.source };
}

export async function prepareShortSource(engine: Engine, goal: GoalRecord, revision: unknown, value: unknown): Promise<GoalRecord> {
  const { content, plan, analysis, source } = preparationContent(engine, goal, revision);
  const input = goalPreparationInputSchema.parse(value);
  const regions = validateCleanupRegions(input.regions ?? analysis.recipe.cleanupRegions, source.durationSeconds);
  const method = input.method ?? analysis.recipe.cleanupMethod;
  const identity = cleanupContentKey(source.mediaHash, method, regions);
  const [current] = await goalReferenceHashes(engine, [source.artifactId]);
  if (current?.objectHash !== source.mediaHash) throw new Error("The source changed after initial analysis. Refresh the analysis before preparing it.");
  const adopted = input.artifactId ? await cleanupCandidate(engine, input.artifactId, source.mediaHash) : null;
  if (input.artifactId && (!adopted || adopted.identity !== identity || adopted.mediaHash !== input.mediaHash)) {
    throw new Error("That cleaned copy does not match the reviewed source, regions, method and media version.");
  }
  const cachedId = engine.settings.get<string>(`video-cleanup.content.${identity}`);
  const cached = cachedId ? readCleanupRequest(engine, cachedId) : null;
  const existing = cached ? await cleanupCandidate(engine, cached.outputArtifactId, source.mediaHash) : null;
  const reviewedMatch = analysis.recipe.cleanupCandidates.find(item => item.identity === identity && item.reviewed);
  const reviewedCopy = reviewedMatch ? await cleanupCandidate(engine, reviewedMatch.artifactId, source.mediaHash) : null;
  const candidate = adopted ?? (reviewedCopy?.reviewed ? reviewedCopy : null) ?? (existing?.reusable ? existing : null);
  if (!candidate && cached && ["queued", "running"].includes(cleanupRenderStatus(engine, cached).status)) {
    throw new Error("This cleanup is already running. Review it when it finishes, then prepare the goal again to reuse it.");
  }
  if (!candidate && method === "lama" && !(await cleanupModelStatus()).lama) throw new Error("Download the local removal model, choose Fast fill, or adopt a matching cleaned copy before preparing.");
  const requestId = `goal-cleanup:${goal.goalId}:${identity}`;
  const recipe = { ...analysis.recipe, cleanupRegions: regions, cleanupMethod: method, cleanupConfirmed: true,
    cleanupFrames: cleanupFrameCount(regions, source.fps),
    cleanupReviewedHash: null, preparedArtifactId: null, preparedMediaHash: null, referenceArtifactId: null, referenceMediaHash: null,
    preparedFrameArtifactId: null, preparedFrameMediaHash: null };
  const nextPlan = { ...plan, analysis: { ...analysis, recipe, intent: { ...analysis.intent, cleanup: "remove" as const, origins: { ...analysis.intent.origins, cleanup: "edited" as const } } } };
  await writeGoalShortContent(engine, goal, { ...content, plan: nextPlan, revision: content.revision + 1 });
  const next = saveGoal(engine, { ...goal, status: "planning", error: null, finish: null,
    preparation: { status: "running", requestId, identity, jobId: null, artifactId: candidate?.artifactId ?? null, mediaHash: candidate?.mediaHash ?? null, error: null } });
  try {
    const job = await queue.enqueue(`goal-prepare:${goal.goalId}:${content.revision + 1}`, {
      type: "prepare_goal_source", bookId: goal.bookId, goalId: goal.goalId, revision: content.revision + 1, identity,
      ...(candidate ? { adoptArtifactId: candidate.artifactId, adoptMediaHash: candidate.mediaHash } : {}),
    });
    return saveGoal(engine, { ...next, planningJobId: job.id, preparation: { ...next.preparation!, jobId: job.id } });
  } catch (error) {
    return saveGoal(engine, { ...next, status: "failed", error: error instanceof Error ? error.message : String(error),
      preparation: { ...next.preparation!, status: "failed", error: error instanceof Error ? error.message : String(error) } });
  }
}

export async function reviewShortSource(engine: Engine, goal: GoalRecord, args: Record<string, unknown>): Promise<GoalRecord> {
  const { content, plan, analysis, source } = preparationContent(engine, goal, args.revision);
  const recipe = analysis.recipe;
  if (args.confirmed !== true || !recipe.preparedArtifactId || !recipe.preparedMediaHash
    || args.artifact_id !== recipe.preparedArtifactId || args.media_hash !== recipe.preparedMediaHash || !goal.preparation
    || goal.preparation.status !== "review") throw new Error("Review the prepared video for remaining graphics, fill defects and sound before using it.");
  const references = await goalReferenceHashes(engine, [source.artifactId, recipe.preparedArtifactId, recipe.referenceArtifactId ?? "", plan.remix!.frame.artifactId]);
  if (references[0]?.objectHash !== source.mediaHash || references[1]?.objectHash !== recipe.preparedMediaHash
    || references[2]?.objectHash !== recipe.referenceMediaHash || references[3]?.objectHash !== recipe.preparedFrameMediaHash
    || references[3]?.artifactId !== recipe.preparedFrameArtifactId) throw new Error("A prepared reference changed. Prepare the source again before approving it.");
  reviewCleanupCopy(engine, goal.preparation.identity, recipe.preparedMediaHash);
  await writeGoalShortContent(engine, goal, { ...content, revision: content.revision + 1,
    plan: { ...plan, analysis: { ...analysis, recipe: { ...recipe, cleanupReviewedHash: recipe.preparedMediaHash } } } });
  return saveGoal(engine, { ...goal, preparation: { ...goal.preparation, status: "ready", error: null } });
}

export function goalPreparationStatus(engine: Engine, goal: GoalRecord) {
  const preparation = goal.preparation;
  if (!preparation) return null;
  const request = readCleanupRequest(engine, preparation.requestId);
  return { ...preparation, progress: request ? cleanupRenderStatus(engine, request).progress : null };
}
