import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import type { Engine } from "videobook-engine";
import { notebookOccupiedSlots } from "videobook-engine/notebook-grid";
import { readGoal, requireGoalContent, saveGoal, type GoalRecord } from "../goal-store.js";
import { completedGoalVideos, writeGoalCombinationState } from "../goal-state.js";
import { mutateNotebook, withNotebookMutation } from "../notebook-mutations.js";
import { nextGenerationOutputSlot } from "../notebook-placement.js";
import { materializeArtifactFile, registerMediaProbe } from "../notebook-media-ops.js";
import { AUDIO_OPTS, H264_MEDIUM, probeVideo, runFfmpeg } from "../ffmpeg.js";
import { queue, registerJobHandler } from "../queue.js";
import { ingestWorkspaceOutputs } from "./_persist-output.js";
import { extractVideoPoster } from "../video-poster.js";

export async function queueGoalCombination(engine: Engine, goal: GoalRecord): Promise<GoalRecord> {
  if (goal.status !== "completed" || !goal.assembly) throw new Error("Complete and assemble the goal before combining its clips");
  if (goal.combined && goal.combined.status !== "failed") return goal;
  const artifactIds = completedGoalVideos(engine, goal);
  if (artifactIds.length < 2 || artifactIds.length !== goal.clipIds.length) throw new Error("The completed goal needs at least two clips");
  const content = requireGoalContent(engine, goal);
  const artifact = await engine.artifacts.create("video", `${content.plan?.title ?? "Video goal"} · Combined`);
  if (!artifact.ok) throw new Error(artifact.error.message);
  const artifactId = artifact.value.artifactId;
  const cellId = uuidv7();
  const placed = await mutateNotebook(engine, goal.notebookId, "goal_combine", document => {
    const anchor = document.cells.find(cell => cell.id === goal.cellId);
    if (!anchor) throw new Error("The goal tile was removed");
    const cell = engine.notebooks.createCell({ id: cellId, type: "video", label: artifact.value.label,
      slot: nextGenerationOutputSlot("generate_video", anchor.slot, notebookOccupiedSlots(document.cells)),
      outputArtifactId: artifactId, inputs: { state: "queued", goalId: goal.goalId, goalRole: "combined" },
    });
    const edges = (goal.stages.videos?.outputs ?? []).flatMap((output, index) => output.cellId && document.cells.some(source => source.id === output.cellId)
      ? [engine.notebooks.createEdge({ source: output.cellId, target: cell.id, targetInput: index === 0 ? "video" : `video_${index + 1}` })] : []);
    return { ...document, cells: [...document.cells, cell], edges: [...document.edges, ...edges] };
  });
  if (!placed.ok) throw new Error(placed.error.message);
  const jobId = `goal-combine-${goal.goalId}-${uuidv7()}`;
  saveGoal(engine, { ...goal, combined: { artifactId, cellId, jobId: null, status: "running", error: null } });
  try {
    const job = await queue.enqueue(jobId, { type: "combine_goal", bookId: goal.bookId, goalId: goal.goalId, assetId: artifactId, artifactIds, cellId });
    const current = readGoal(engine, goal.goalId);
    saveGoal(engine, { ...current, combined: { ...current.combined!, jobId: job.id } });
  } catch (error) {
    await writeCombinationState(engine, goal.goalId, artifactId, error instanceof Error ? error.message : String(error));
    throw error;
  }
  return readGoal(engine, goal.goalId);
}

async function writeCombinationState(engine: Engine, goalId: string, artifactId: string, error: string | null): Promise<void> {
  const goal = readGoal(engine, goalId);
  if (goal.combined?.artifactId !== artifactId) return;
  await writeGoalCombinationState(engine, goal, error);
}

export function registerCombineGoalJob(engine: Engine): void {
  registerJobHandler("combine_goal", async (payload, context) => {
    const goalId = String(payload.goalId);
    const artifactId = String(payload.assetId);
    const artifactIds = payload.artifactIds as string[];
    const sources: Awaited<ReturnType<typeof materializeArtifactFile>>[] = [];
    try {
      for (const id of artifactIds) sources.push(await materializeArtifactFile(engine, id, ["original.mp4"]));
      const probes = await Promise.all(sources.map(source => probeVideo(source.path)));
      const first = probes[0]!;
      if (probes.some(probe => probe.videoDuration <= 0 || probe.width <= 0 || probe.height <= 0)) throw new Error("A goal clip has no playable video");
      const width = Math.ceil(first.width / 2) * 2;
      const height = Math.ceil(first.height / 2) * 2;
      const fps = first.fps || 30;
      const filters = probes.flatMap((probe, index) => [
        `[${index}:v]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${index}]`,
        `${probe.hasAudio ? `[${index}:a]aresample=48000,asetpts=PTS-STARTPTS,apad` : "anullsrc=r=48000:cl=stereo"},atrim=duration=${probe.videoDuration}[a${index}]`,
      ]);
      filters.push(`${sources.map((_, index) => `[v${index}][a${index}]`).join("")}concat=n=${sources.length}:v=1:a=1[v][a]`);
      const workspace = await engine.workspaces.resolveArtifact(artifactId);
      if (!workspace.ok) throw new Error(workspace.error.message);
      const path = join(workspace.value, "original.mp4");
      await runFfmpeg(["-y", ...sources.flatMap(source => ["-i", source.path]), "-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]", ...H264_MEDIUM, ...AUDIO_OPTS, "-movflags", "+faststart", path], { signal: context.signal });
      await ingestWorkspaceOutputs(engine, artifactId, ["original.mp4"], "goal_combine", { goalId, artifactIds });
      const probe = await probeVideo(path);
      await registerMediaProbe(engine, artifactId, "original.mp4", probe);
      const poster = await engine.files.write(artifactId, "original.jpg", await extractVideoPoster(path, probe.duration, context.signal));
      if (!poster.ok) throw new Error(poster.error.message);
      await withNotebookMutation(`goal:${goalId}`, () => writeCombinationState(engine, goalId, artifactId, null));
      return { asset_id: artifactId, cell_id: payload.cellId, status: "completed" };
    } catch (error) {
      await withNotebookMutation(`goal:${goalId}`, () => writeCombinationState(engine, goalId, artifactId, error instanceof Error ? error.message : String(error)));
      throw error;
    } finally {
      await Promise.all(sources.map(source => source.cleanup()));
    }
  });
}
