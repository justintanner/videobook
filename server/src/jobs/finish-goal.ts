import { createHash } from "node:crypto";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import type { Engine } from "videobook-engine";
import { findPrimaryMediaFile } from "videobook-engine";
import { coldOpenDestination, coldOpenSource } from "../cold-open.js";
import { probeVideo } from "../ffmpeg.js";
import type { ShortFinishTitle } from "../goal-short-plan.js";
import { isCurrentShort, readGoal, requireGoalShortContent, saveGoal, type GoalFinish, type GoalRecord } from "../goal-store.js";
import { watermarkGraphicsTemplate } from "../graphics/templates.js";
import { goalBrandingDocument, goalFinishRecipeSchema, type GoalFinishRecipe } from "../goal-finish-model.js";
import { goalFinishTitleSlots } from "../goal-finish-settings.js";
import { assertGoalFinishRecipe, renderGoalFinishAudio, renderGoalFinishBranding } from "../goal-finish-render.js";
import { shortFinishSource } from "../goal-short-runtime.js";
import { assertRemixEditSources, bindGoalRemixEdit, goalRemixEditSchema, remixEditIdentity, renderGoalRemixAssembly, validateRemixAssembly, type GoalRemixEdit } from "../goal-remix-assembly.js";
import { finishingIdentityKey, watermarkProfileFor } from "../lightning-defaults.js";
import { mutateNotebook, withNotebookMutation } from "../notebook-mutations.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { queue, registerJobHandler } from "../queue.js";
import { applyWatermarkDef } from "../tools/apply-watermark.js";
import { effectiveWatermarkProfile, readWatermarkConfig } from "../watermark-config.js";

const FINISH_MESSAGE = "Only a reviewed short can finish.";

type FinishPayload = { goalId: string; identity: string; runId: string | null; title: ShortFinishTitle | null; edit: GoalRemixEdit | null; recipe: GoalFinishRecipe | null };

function textOf(result: { isError?: boolean; content?: Array<{ type?: string; text?: string }> }): string {
  return result.content?.find(entry => entry.type === "text")?.text ?? "";
}

function currentFinish(engine: Engine, goalId: string, identity: string, runId: string | null): GoalRecord | null {
  const goal = readGoal(engine, goalId);
  if (goal.finish?.identity !== identity || (goal.finish.runId ?? null) !== runId || goal.finish.status === "cancelled" || goal.status === "cancelled") return null;
  return goal;
}

async function duplicatePlayableVideo(engine: Engine, sourceArtifactId: string, label: string, sourceObjectHash?: string): Promise<string> {
  const source = await coldOpenSource(engine, sourceArtifactId, sourceObjectHash);
  const created = await engine.artifacts.create({ kind: "video", label });
  if (!created.ok) throw new Error(created.error.message);
  const artifactId = created.value.artifactId;
  const copied = await engine.files.copy(sourceArtifactId, source.file.name, artifactId, "original.mp4");
  if (!copied.ok) throw new Error(copied.error.message);
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const probe = await probeVideo(join(manifest.value.path, "original.mp4"));
  await registerMediaProbe(engine, artifactId, "original.mp4", probe, { transcribe: false });
  return artifactId;
}

function payloadTitle(value: unknown): ShortFinishTitle | null {
  const title = value && typeof value === "object" ? value as Record<string, unknown> : null;
  return title && typeof title.headline === "string" && typeof title.secondary === "string"
    ? { headline: title.headline, secondary: title.secondary }
    : null;
}

function burnedTitle(engine: Engine, goal: GoalRecord): ShortFinishTitle | null {
  const plan = requireGoalShortContent(engine, goal).plan;
  const title = plan?.finish.title;
  const slots = goalFinishTitleSlots(engine, plan);
  if (!title || !slots.headline) return null;
  return { headline: title.headline, secondary: slots.secondary ? title.secondary : "" };
}

async function burnSavedWatermark(engine: Engine, artifactId: string, sourceArtifactId: string, title: ShortFinishTitle | null): Promise<void> {
  const apply = applyWatermarkDef(engine, { transcribe: false, title });
  const result = await apply.handler({
    book_id: engine.book.get().bookId,
    asset_id: artifactId,
    source_asset_id: sourceArtifactId,
    platform: "tiktok",
    mode: "burn",
    wait: true,
  });
  const text = textOf(result);
  if (result.isError) throw new Error(text || "Watermark failed");
}

async function placeFinishedCell(engine: Engine, goal: GoalRecord, artifactId: string, sourceArtifactId: string): Promise<void> {
  const placed = await mutateNotebook(engine, goal.notebookId, "goal_finish", notebook => {
    if (notebook.cells.some(cell => cell.outputArtifactId === artifactId)) return notebook;
    const cell = engine.notebooks.createCell({
      type: "video",
      label: "Finished",
      slot: coldOpenDestination(notebook, sourceArtifactId),
      outputArtifactId: artifactId,
      inputs: { sourceOperation: "goal_finish", sourceArtifactId, state: "completed" },
    });
    return { ...notebook, cells: [...notebook.cells, cell] };
  }, { goalId: goal.goalId, artifactId });
  if (!placed.ok) throw new Error(placed.error.message);
}

async function finishProgress(engine: Engine, payload: FinishPayload, patch: Partial<GoalFinish>): Promise<void> {
  await withNotebookMutation(`goal:${payload.goalId}`, async () => {
    const goal = currentFinish(engine, payload.goalId, payload.identity, payload.runId);
    if (!goal?.finish || goal.finish.status !== "running") throw new Error("Finishing was superseded or cancelled.");
    saveGoal(engine, { ...goal, finish: { ...goal.finish, ...patch } });
  });
}

async function runFinish(engine: Engine, payload: FinishPayload, signal: AbortSignal): Promise<{ finalArtifactId: string }> {
  const goal = currentFinish(engine, payload.goalId, payload.identity, payload.runId);
  if (!goal?.finish || goal.finish.status === "completed") return { finalArtifactId: goal?.finish?.finalArtifactId ?? "" };
  signal.throwIfAborted();
  await coldOpenSource(engine, goal.finish.sourceArtifactId, goal.finish.sourceObjectHash ?? undefined);
  if (payload.recipe) await assertGoalFinishRecipe(engine, payload.recipe);
  const assemblyEdit = payload.edit && payload.recipe ? { ...payload.edit, audio: payload.recipe.audio === "mix" || payload.recipe.audio === "generated" ? "generated" as const : "mute" as const } : payload.edit;
  const assembled = assemblyEdit ? await renderGoalRemixAssembly(engine, assemblyEdit, signal) : null;
  signal.throwIfAborted();
  if (!currentFinish(engine, payload.goalId, payload.identity, payload.runId)) throw new Error("Finishing was superseded or cancelled.");
  const finalArtifactId = await duplicatePlayableVideo(engine, assembled?.artifactId ?? goal.finish.sourceArtifactId, "Finished", assembled?.mediaHash ?? goal.finish.sourceObjectHash ?? undefined);
  await finishProgress(engine, payload, { workingArtifactId: finalArtifactId, ...(assembled ? { assembledArtifactId: assembled.artifactId } : {}), phase: "audio" });
  if (payload.recipe) {
    await renderGoalFinishAudio(engine, finalArtifactId, payload.recipe, signal);
    await finishProgress(engine, payload, { phase: "branding" });
    if (payload.recipe.branding) await renderGoalFinishBranding(engine, finalArtifactId, payload.recipe.branding, payload.title, signal);
  } else {
    await finishProgress(engine, payload, { phase: "branding" });
    await burnSavedWatermark(engine, finalArtifactId, goal.finish.sourceArtifactId, payload.title);
  }
  await finishProgress(engine, payload, { phase: "validation" });
  const manifest = await engine.files.manifest(finalArtifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = findPrimaryMediaFile(manifest.value.files, "video");
  if (!file) throw new Error("The finished video is missing");
  const probe = await probeVideo(join(manifest.value.path, file.name));
  if (!probe.videoStream || probe.videoDuration < 0.5) throw new Error("The finished video is not playable");
  await coldOpenSource(engine, goal.finish.sourceArtifactId, goal.finish.sourceObjectHash ?? undefined);
  if (payload.recipe) {
    await assertGoalFinishRecipe(engine, payload.recipe);
    if (payload.recipe.audio === "mute" && probe.hasAudio) throw new Error("The muted finish still contains audio.");
    if (["source", "mix"].includes(payload.recipe.audio) && (!probe.hasAudio || Math.abs((probe.audioDuration ?? 0) - probe.videoDuration) > 0.06)) throw new Error("The finished soundtrack does not cover the final video duration.");
    const provenance = await engine.files.write(finalArtifactId, "goal-finish.json", JSON.stringify({ ...payload, outputHash: file.objectHash, sourceArtifactId: goal.finish.sourceArtifactId, sourceObjectHash: goal.finish.sourceObjectHash, ...(assembled ? { assembledArtifactId: assembled.artifactId } : {}) }));
    if (!provenance.ok) throw new Error(provenance.error.message);
  }
  if (payload.edit) {
    await validateRemixAssembly(join(manifest.value.path, file.name), payload.edit, signal);
    await assertRemixEditSources(engine, payload.edit);
  }
  await withNotebookMutation(`goal:${payload.goalId}`, async () => {
    signal.throwIfAborted();
    const latest = currentFinish(engine, payload.goalId, payload.identity, payload.runId);
    if (!latest?.finish) return;
    requireGoalShortContent(engine, latest);
    await placeFinishedCell(engine, latest, finalArtifactId, latest.finish.sourceArtifactId);
    saveGoal(engine, {
      ...latest,
      status: "completed",
      error: null,
      finish: { ...latest.finish, status: "completed", phase: "completed", finalArtifactId, ...(assembled ? { assembledArtifactId: assembled.artifactId } : {}), error: null },
    });
  });
  return { finalArtifactId };
}

export function registerFinishGoalJob(engine: Engine): void {
  registerJobHandler("finish_goal", async (input, context) => {
    const goalId = typeof input.goalId === "string" ? input.goalId : "";
    const identity = typeof input.identity === "string" ? input.identity : "";
    const runId = typeof input.runId === "string" ? input.runId : null;
    try {
      return await runFinish(engine, { goalId, identity, runId, title: payloadTitle(input.title), edit: input.edit ? goalRemixEditSchema.parse(input.edit) : null,
        recipe: input.recipe ? goalFinishRecipeSchema.parse(input.recipe) : null }, context.signal);
    } catch (error) {
      const goal = readGoal(engine, goalId);
      if (goal.finish?.identity === identity && (goal.finish.runId ?? null) === runId && goal.finish.status === "running") {
        saveGoal(engine, {
          ...goal,
          status: "review",
          finish: { ...goal.finish, status: "failed", error: error instanceof Error ? error.message : String(error) },
        });
      }
      throw error;
    }
  });
}

export async function queueGoalFinish(engine: Engine, goal: GoalRecord): Promise<GoalRecord> {
  if (!isCurrentShort(goal.planVersion)) throw new Error(FINISH_MESSAGE);
  if (goal.status === "running") throw new Error("Wait until the video is ready before finishing it");
  if (!["review", "completed", "failed", "interrupted"].includes(goal.status)) throw new Error("Review the video before finishing it");
  if (goal.finish?.status === "running" && goal.finish.jobId) {
    const active = engine.jobs.queue.get(goal.finish.jobId);
    if (active && ["queued", "running", "completing"].includes(active.state)) return goal;
  }
  const source = await coldOpenSource(engine, await shortFinishSource(engine, goal));
  const edit = await bindGoalRemixEdit(engine, goal, source.artifact.artifactId);
  const plan = requireGoalShortContent(engine, goal).plan;
  const analysis = plan?.version === 5 ? plan.analysis : null;
  const recipe = analysis?.recipe.branding ? goalFinishRecipeSchema.parse({
    version: 1, branding: analysis.preferences.branding ? analysis.recipe.branding : null,
    audio: analysis.intent.audio, soundtrack: analysis.recipe.soundtrack ?? null,
  }) : null;
  if (recipe) await assertGoalFinishRecipe(engine, recipe);
  const config = await readWatermarkConfig(engine, "tiktok");
  const profile = effectiveWatermarkProfile(config, "tiktok");
  const template = watermarkGraphicsTemplate(engine, "tiktok");
  const title = burnedTitle(engine, goal);
  if (recipe?.branding) goalBrandingDocument(recipe.branding, title, edit ? edit.assembly.totalFrames / edit.assembly.fps : source.durationSeconds, { width: 1080, height: 1920 });
  const identity = recipe ? `finish:${createHash("sha256").update(JSON.stringify({ sourceHash: source.file.objectHash, edit, recipe, title })).digest("hex")}` : (edit ? "remix:" : "watermark-only:") + finishingIdentityKey({
    sourceObjectHash: edit ? remixEditIdentity(edit) : source.file.objectHash,
    startSeconds: 0,
    endSeconds: 0,
    profile: watermarkProfileFor(profile.platform, profile),
    qrStartSeconds: config.profile?.qrStartSeconds,
    qrEndSeconds: config.profile?.qrEndSeconds,
    watermarkTemplate: template ? createHash("sha256").update(JSON.stringify(template.document)).digest("hex") : null,
    title,
  });
  if (goal.finish?.status === "completed" && (!recipe || goal.finish.identity === identity)) return goal;
  const finish: GoalFinish = {
    status: "running",
    sourceArtifactId: source.artifact.artifactId,
    sourceObjectHash: source.file.objectHash,
    identity,
    runId: uuidv7(),
    phase: edit ? "assembly" : "audio",
    previousArtifactIds: [...new Set([...(goal.finish?.previousArtifactIds ?? []), goal.finish?.workingArtifactId, goal.finish?.finalArtifactId].filter((id): id is string => Boolean(id)))],
    finalArtifactId: null,
    jobId: null,
    error: null,
  };
  saveGoal(engine, { ...goal, status: "review", error: null, finish });
  const job = await queue.enqueue(`goal-finish-${goal.goalId}-${uuidv7()}`, {
    type: "finish_goal",
    bookId: goal.bookId,
    goalId: goal.goalId,
    identity,
    runId: finish.runId,
    ...(edit ? { edit } : {}),
    ...(recipe ? { recipe } : {}),
    ...(title ? { title } : {}),
  });
  const queued = readGoal(engine, goal.goalId);
  if (!queued.finish || queued.finish.identity !== identity || queued.finish.status !== "running") return queued;
  return saveGoal(engine, { ...queued, finish: { ...queued.finish, jobId: job.id } });
}
