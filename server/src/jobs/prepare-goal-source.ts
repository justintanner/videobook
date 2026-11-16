import type { Engine } from "videobook-engine";
import { registerJobHandler, type JobHandlerContext } from "../queue.js";
import { readGoal, requireGoalShortContent, saveGoal, writeGoalShortContent } from "../goal-store.js";
import { estimateShort, mentionedSourceFrame } from "../goal-short-runtime.js";
import { goalReferenceHashes } from "../goal-reference-images.js";
import { prepareGoalSourceReference } from "../goal-source-reference.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import { cleanupCandidate, cleanupContentKey, validateCleanupCopy } from "../video-cleanup/prepared.js";
import { cleanupDestination, readCleanupRequest, requestCleanupRender } from "../video-cleanup/service.js";
import { runCleanupRequest } from "./remove-video-graphics.js";
import { placeRenderedCell } from "./_render-output.js";

async function prepareSource(engine: Engine, input: Record<string, unknown>, ctx: JobHandlerContext) {
  const goalId = String(input.goalId);
  const goal = readGoal(engine, goalId);
  const content = requireGoalShortContent(engine, goal);
  const plan = content.plan;
  if (goal.status !== "planning" || plan?.version !== 5 || !plan.analysis?.source || !plan.remix || !goal.preparation
    || goal.preparation.identity !== input.identity || content.revision !== input.revision) return { goalId };
  const { analysis } = plan;
  const source = analysis.source!;
  const recipe = analysis.recipe;
  if (!recipe.cleanupConfirmed || cleanupContentKey(source.mediaHash, recipe.cleanupMethod, recipe.cleanupRegions) !== input.identity) throw new Error("The saved preparation recipe changed. Review the regions again.");
  let artifactId: string;
  if (typeof input.adoptArtifactId === "string") {
    const candidate = await cleanupCandidate(engine, input.adoptArtifactId, source.mediaHash);
    if (!candidate || candidate.identity !== input.identity || candidate.mediaHash !== input.adoptMediaHash) throw new Error("The cleaned copy changed before preparation. Review its current version.");
    artifactId = candidate.artifactId;
  } else {
    const status = await requestCleanupRender(engine, goal.bookId, source.artifactId, {
      requestId: goal.preparation.requestId, sourceHash: source.mediaHash, notebookId: goal.notebookId,
      method: recipe.cleanupMethod, regions: recipe.cleanupRegions,
    }, ctx.jobId);
    artifactId = status.output_asset_id;
    if (status.status !== "completed") {
      if (status.job_id !== ctx.jobId) throw new Error("The matching cleanup is already running. Retry preparation after it finishes to reuse it.");
      const request = readCleanupRequest(engine, status.request_id);
      if (!request) throw new Error("The cleanup request is missing.");
      await runCleanupRequest(engine, goal.bookId, request, ctx);
    }
  }
  const prepared = await validateCleanupCopy(engine, source.artifactId, artifactId, source.mediaHash, ctx.signal);
  const placement = await placeRenderedCell(engine, {
    notebookId: goal.notebookId, operation: "goal_prepare", sourceArtifactId: source.artifactId, outputArtifactId: artifactId,
    fallbackLabel: "Cleaned source", destination: notebook => cleanupDestination(notebook, source.artifactId),
    inputs: { sourceOperation: "remove_video_graphics", sourceArtifactId: source.artifactId },
  });
  const atSeconds = recipe.sourceFrameSeconds ?? plan.remix.frame.atSeconds;
  const reference = await prepareGoalSourceReference(engine, artifactId, atSeconds, goal.notebookId, ctx.signal);
  const frame = await mentionedSourceFrame(engine, goal.bookId, goal.notebookId,
    { artifactId, cellId: placement.cellId, address: placement.address, label: "Prepared source" }, "The prepared source", atSeconds);
  if (!frame.remix) throw new Error("The prepared source frame could not be read.");
  const [frameHash] = await goalReferenceHashes(engine, [frame.remix.frame.artifactId]);
  if (!frameHash?.objectHash) throw new Error("The prepared source frame is missing.");
  const reviewed = (await cleanupCandidate(engine, artifactId, source.mediaHash))?.reviewed ?? false;
  const nextPlan = { ...plan, remix: { ...plan.remix, frame: frame.remix.frame }, analysis: { ...analysis, recipe: {
    ...recipe, preparedArtifactId: artifactId, preparedMediaHash: prepared.mediaHash, cleanupReviewedHash: reviewed ? prepared.mediaHash : null,
    preparedFrameArtifactId: frame.remix.frame.artifactId, preparedFrameMediaHash: frameHash.objectHash,
    referenceArtifactId: reference.artifactId, referenceMediaHash: reference.mediaHash, reference: { start: reference.start, end: reference.end },
  } } };
  const estimate = await estimateShort(engine, nextPlan, content);
  await withNotebookMutation(`goal:${goalId}`, async () => {
    const current = readGoal(engine, goalId);
    const latest = requireGoalShortContent(engine, current);
    if (current.status !== "planning" || !current.preparation || current.preparation.identity !== input.identity || latest.revision !== input.revision) return;
    ctx.signal.throwIfAborted();
    const hashes = await goalReferenceHashes(engine, [source.artifactId, artifactId]);
    if (hashes[0]?.objectHash !== source.mediaHash || hashes[1]?.objectHash !== prepared.mediaHash) throw new Error("The source or prepared copy changed during preparation.");
    await writeGoalShortContent(engine, current, { ...latest, plan: nextPlan, estimate, revision: latest.revision + 1 });
    saveGoal(engine, { ...current, status: "review", error: null,
      preparation: { ...current.preparation, status: reviewed ? "ready" : "review", artifactId, mediaHash: prepared.mediaHash, error: null } });
  });
  return { goalId, output_asset_id: artifactId, cell_id: placement.cellId, address: placement.address };
}

export function registerPrepareGoalSourceJob(engine: Engine): void {
  registerJobHandler("prepare_goal_source", async (input, ctx) => {
    try { return await prepareSource(engine, input, ctx); } catch (error) {
      await withNotebookMutation(`goal:${String(input.goalId)}`, async () => {
        const goal = readGoal(engine, String(input.goalId));
        if (goal.status !== "planning" || !goal.preparation || goal.preparation.identity !== input.identity) return;
        if (requireGoalShortContent(engine, goal).revision !== input.revision) return;
        const message = error instanceof Error ? error.message : String(error);
        saveGoal(engine, { ...goal, status: "failed", error: message, preparation: { ...goal.preparation, status: "failed", error: message } });
      });
      throw error;
    }
  });
}
