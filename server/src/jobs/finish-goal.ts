import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import type { Engine } from "videobook-engine";
import { findPrimaryMediaFile } from "videobook-engine";
import { coldOpenDestination, coldOpenSource } from "../cold-open.js";
import { coldOpenRangeError } from "../cold-open-model.js";
import { probeVideo } from "../ffmpeg.js";
import { readGoal, saveGoal, type GoalFinish, type GoalRecord } from "../goal-store.js";
import { goalAssemblyStale } from "../goal-state.js";
import { finishingIdentityKey, watermarkProfileFor } from "../lightning-defaults.js";
import { mutateNotebook } from "../notebook-mutations.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { queue, registerJobHandler } from "../queue.js";
import { applyWatermarkDef } from "../tools/apply-watermark.js";
import { coldOpenDefs } from "../tools/cold-open.js";
import { effectiveWatermarkProfile, readWatermarkConfig } from "../watermark-config.js";

const FINISH_MESSAGE = "Only a reviewed scene and video goal can finish with a cold open.";
const ASSEMBLY_MESSAGE = "The goal's timeline clips were edited. Keep those edits and place the revised videos manually.";

type FinishPayload = { goalId: string; identity: string };

function textOf(result: { isError?: boolean; content?: Array<{ type?: string; text?: string }> }): string {
  return result.content?.find(entry => entry.type === "text")?.text ?? "";
}

function currentFinish(engine: Engine, goalId: string, identity: string): GoalRecord | null {
  const goal = readGoal(engine, goalId);
  if (goal.finish?.identity !== identity || goal.finish.status === "cancelled") return null;
  return goal;
}

function finishSourceId(engine: Engine, goal: GoalRecord): string {
  if (goal.assembly && goalAssemblyStale(engine, goal)) throw new Error(ASSEMBLY_MESSAGE);
  if (goal.combined?.status === "completed" && goal.combined.artifactId && !goalAssemblyStale(engine, goal)) return goal.combined.artifactId;
  const selected = goal.stages.videos?.outputs[0]?.artifactId ?? goal.finish?.sourceArtifactId;
  if (!selected) throw new Error("Approve a video before finishing it");
  return selected;
}

async function waitForQueuedJob(engine: Engine, id: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const job = engine.jobs.queue.get(id);
    if (!job) throw new Error("The finishing job disappeared");
    if (job.state === "done") return;
    if (job.state === "failed" || job.state === "aborted") throw new Error(job.error?.message ?? `Finishing ${job.state}`);
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Finishing timed out");
}

async function renderColdOpen(engine: Engine, goal: GoalRecord, signal: AbortSignal): Promise<string> {
  const finish = goal.finish;
  if (!finish?.coldOpenRequestId || finish.startSeconds == null || finish.endSeconds == null || !finish.sourceObjectHash) {
    throw new Error("The cold open is missing its reviewed range");
  }
  const existing = finish.coldOpenArtifactId;
  if (existing && engine.artifacts.get(existing).ok) {
    const manifest = await engine.files.manifest(existing);
    if (manifest.ok && manifest.value.files.some(file => file.name === "original.mp4")) return existing;
  }
  const edit = coldOpenDefs(engine).find(def => def.name === "edit_cold_open");
  if (!edit) throw new Error("Cold open editing is unavailable");
  const result = await edit.handler({
    book_id: goal.bookId,
    notebook_id: goal.notebookId,
    asset_id: finish.sourceArtifactId,
    source_object_hash: finish.sourceObjectHash,
    start_time: finish.startSeconds,
    end_time: finish.endSeconds,
    request_id: finish.coldOpenRequestId,
  });
  const text = textOf(result);
  if (result.isError) throw new Error(text || "Cold open failed");
  const parsed = JSON.parse(text) as { job_id?: number; output_asset_id?: string; status?: string };
  if (typeof parsed.job_id === "number" && parsed.status !== "completed") await waitForQueuedJob(engine, parsed.job_id, signal);
  if (!parsed.output_asset_id) throw new Error("Cold open did not return a video");
  const saved = currentFinish(engine, goal.goalId, finish.identity ?? "");
  if (saved?.finish) {
    saveGoal(engine, { ...saved, finish: { ...saved.finish, coldOpenArtifactId: parsed.output_asset_id } });
  }
  return parsed.output_asset_id;
}

async function duplicatePlayableVideo(engine: Engine, sourceArtifactId: string, label: string): Promise<string> {
  const source = await coldOpenSource(engine, sourceArtifactId);
  const created = await engine.artifacts.create({ kind: "video", label });
  if (!created.ok) throw new Error(created.error.message);
  const artifactId = created.value.artifactId;
  const copied = await engine.files.copy(sourceArtifactId, source.file.name, artifactId, "original.mp4");
  if (!copied.ok) throw new Error(copied.error.message);
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const probe = await probeVideo(join(manifest.value.path, "original.mp4"));
  await registerMediaProbe(engine, artifactId, "original.mp4", probe);
  return artifactId;
}

async function burnSavedWatermark(engine: Engine, artifactId: string): Promise<void> {
  const apply = applyWatermarkDef(engine);
  const result = await apply.handler({
    book_id: engine.book.get().bookId,
    asset_id: artifactId,
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

async function runFinish(engine: Engine, payload: FinishPayload, signal: AbortSignal): Promise<{ finalArtifactId: string; coldOpenArtifactId: string }> {
  const goal = currentFinish(engine, payload.goalId, payload.identity);
  if (!goal?.finish) return { finalArtifactId: "", coldOpenArtifactId: "" };
  const coldOpenArtifactId = await renderColdOpen(engine, goal, signal);
  const running = currentFinish(engine, payload.goalId, payload.identity);
  if (!running?.finish) return { finalArtifactId: "", coldOpenArtifactId };
  const finalArtifactId = await duplicatePlayableVideo(engine, coldOpenArtifactId, "Finished");
  await burnSavedWatermark(engine, finalArtifactId);
  const manifest = await engine.files.manifest(finalArtifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = findPrimaryMediaFile(manifest.value.files, "video");
  if (!file) throw new Error("The finished video is missing");
  const probe = await probeVideo(join(manifest.value.path, file.name));
  if (!probe.videoStream || probe.videoDuration < 0.5) throw new Error("The finished video is not playable");
  await placeFinishedCell(engine, running, finalArtifactId, running.finish.sourceArtifactId);
  const latest = currentFinish(engine, payload.goalId, payload.identity);
  if (!latest?.finish) return { finalArtifactId, coldOpenArtifactId };
  saveGoal(engine, {
    ...latest,
    status: "completed",
    error: null,
    finish: { ...latest.finish, status: "completed", coldOpenArtifactId, finalArtifactId, error: null },
  });
  return { finalArtifactId, coldOpenArtifactId };
}

export function registerFinishGoalJob(engine: Engine): void {
  registerJobHandler("finish_goal", async (input, context) => {
    const goalId = typeof input.goalId === "string" ? input.goalId : "";
    const identity = typeof input.identity === "string" ? input.identity : "";
    try {
      return await runFinish(engine, { goalId, identity }, context.signal);
    } catch (error) {
      const goal = readGoal(engine, goalId);
      if (goal.finish?.identity === identity && goal.finish.status === "running") {
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

export async function queueGoalFinish(engine: Engine, goal: GoalRecord, args: Record<string, unknown>): Promise<GoalRecord> {
  if (goal.planVersion !== 3) throw new Error(FINISH_MESSAGE);
  if (goal.status === "running") throw new Error("Wait until the video is ready before finishing it");
  if (!["review", "completed", "failed", "interrupted"].includes(goal.status)) throw new Error("Review the finished video before approving its cold open");
  const source = await coldOpenSource(engine, finishSourceId(engine, goal));
  const start = args.start_seconds;
  const end = args.end_seconds;
  if (start === undefined && end === undefined) {
    if (goal.finish?.status === "completed" || goal.finish?.status === "running") return goal;
    const suggestion: GoalFinish = {
      status: "review",
      sourceArtifactId: source.artifact.artifactId,
      sourceObjectHash: source.file.objectHash,
      finalArtifactId: null,
      error: null,
    };
    return saveGoal(engine, { ...goal, status: "review", finish: suggestion });
  }
  if (typeof start !== "number" || typeof end !== "number") throw new Error("Approve both the cold-open start and end");
  const rangeError = coldOpenRangeError(start, end, source.durationSeconds);
  if (rangeError) throw new Error(rangeError);
  const profile = effectiveWatermarkProfile(await readWatermarkConfig(engine, "tiktok"), "tiktok");
  const identity = finishingIdentityKey({
    sourceObjectHash: source.file.objectHash,
    startSeconds: start,
    endSeconds: end,
    profile: watermarkProfileFor(profile.platform, profile),
  });
  const same = goal.finish?.identity === identity;
  if (same && goal.finish?.status === "completed" && goal.finish.finalArtifactId && engine.artifacts.get(goal.finish.finalArtifactId).ok) {
    return saveGoal(engine, { ...goal, status: "completed", error: null });
  }
  if (same && goal.finish?.status === "running" && goal.finish.jobId) {
    const active = engine.jobs.queue.get(goal.finish.jobId);
    if (active && ["queued", "running", "completing"].includes(active.state)) return goal;
  }
  const finish: GoalFinish = {
    status: "running",
    sourceArtifactId: source.artifact.artifactId,
    sourceObjectHash: source.file.objectHash,
    startSeconds: start,
    endSeconds: end,
    identity,
    coldOpenArtifactId: same ? goal.finish?.coldOpenArtifactId ?? null : null,
    coldOpenRequestId: same && goal.finish?.coldOpenRequestId ? goal.finish.coldOpenRequestId : uuidv7(),
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
  });
  const queued = readGoal(engine, goal.goalId);
  if (!queued.finish || queued.finish.identity !== identity || queued.finish.status !== "running") return queued;
  return saveGoal(engine, { ...queued, finish: { ...queued.finish, jobId: job.id } });
}
