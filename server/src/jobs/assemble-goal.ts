import { findVideoFile, MVP_CONTRACT_VERSION, sourceTicksToSequenceFrames } from "videobook-engine";
import type { Engine, EditIntent, InsertClipOperation } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { readGoal, saveGoal, type GoalRecord } from "../goal-store.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import { fittedTransform } from "../rhythm/visual-fit.js";

export async function appendGoalClips(engine: Engine, goal: GoalRecord, artifactIds: string[]) {
  if (!goal.plan || artifactIds.length !== goal.plan.shots.length || goal.clipIds.length !== artifactIds.length) {
    throw new Error("The finished clips do not match the reviewed goal");
  }
  const sequence = engine.sequences.getPrimary();
  const existing = sequence.clips.filter((clip) => goal.clipIds.includes(clip.clipId));
  if (existing.length) {
    if (existing.length !== artifactIds.length) throw new Error("Some goal clips were already edited or removed. Review the sequence before assembling again.");
    return {
      sequenceId: sequence.sequenceId,
      startFrame: Math.min(...existing.map((clip) => clip.timelineStartFrame)),
      durationFrames: existing.reduce((sum, clip) => sum + clip.durationFrames, 0),
    };
  }
  if (goal.assembly) throw new Error("This goal was already assembled; its clips have since been removed");
  const track = sequence.tracks.find((candidate) => candidate.trackId === goal.trackId);
  if (!track || track.kind !== "video" || track.locked || !track.enabled) {
    throw new Error("The goal's video track is no longer editable. Unlock or enable it, then assemble again.");
  }
  const startFrame = Math.max(0,
    ...sequence.clips.map((clip) => clip.timelineStartFrame + clip.durationFrames),
    ...sequence.captions.map((caption) => caption.timelineStartFrame + caption.durationFrames));
  let cursor = startFrame;
  const operations: InsertClipOperation[] = [];
  for (const [index, artifactId] of artifactIds.entries()) {
    const status = await engine.status.get(artifactId);
    if (!status.ok || status.value !== "ready") throw new Error(`Shot ${index + 1} is still processing`);
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const file = findVideoFile(manifest.value.files);
    const streams = engine.streams.list(artifactId);
    if (!streams.ok) throw new Error(streams.error.message);
    const stream = streams.value.find((candidate) => candidate.kind === "video"
      && candidate.objectHash === file?.objectHash && candidate.sourcePath === file?.name);
    if (!stream) throw new Error(`Shot ${index + 1} has no playable video stream`);
    const durationFrames = sourceTicksToSequenceFrames(stream.durationTicks, stream.timeBase, sequence.frameRate, "floor");
    if (durationFrames < 1) throw new Error(`Shot ${index + 1} has no playable frames`);
    operations.push({
      kind: "insert-clip", mode: "overwrite", clipId: goal.clipIds[index]!,
      placement: {
        trackId: track.trackId, timelineStartFrame: cursor, durationFrames,
        source: { kind: "timed", artifactId, range: {
          streamId: stream.streamId, objectHash: stream.objectHash,
          startTick: 0, durationTicks: stream.durationTicks, timeBase: stream.timeBase,
        } },
        speed: { numerator: 1, denominator: 1 }, reverse: false, audioPolicy: "preserve-pitch",
        audio: { gainDb: 0, muted: false, fadeInFrames: 0, fadeOutFrames: 0 },
        transform: fittedTransform("fit"),
      },
    });
    cursor += durationFrames;
  }
  const intent: EditIntent = {
    intentVersion: MVP_CONTRACT_VERSION, commandId: goal.goalId, sequenceId: sequence.sequenceId,
    baseRevision: sequence.revision, actor: "goal", sourceSurface: "system",
    confirmationPolicy: "reversible-single-step", operations,
  };
  const preview = engine.edits.preview(intent);
  if (!preview.ok) throw new Error(preview.error.message);
  const committed = await engine.edits.commit(intent, preview.value.previewHash);
  if (!committed.ok) throw new Error(committed.error.message);
  return { sequenceId: sequence.sequenceId, startFrame, durationFrames: cursor - startFrame };
}

export function registerAssembleGoalJob(engine: Engine): void {
  registerJobHandler("assemble_goal", async (payload, context) => {
    const goalId = String(payload.goalId);
    return withNotebookMutation(`goal:${goalId}`, async () => {
      const goal = readGoal(engine, goalId);
      if (context.signal.aborted || goal.status === "cancelled") throw new Error("Goal cancelled");
      const assembly = await appendGoalClips(engine, goal, payload.artifactIds as string[]);
      saveGoal(engine, { ...readGoal(engine, goalId), assembly });
      return { sequence_id: assembly.sequenceId, status: "completed" };
    });
  });
}
