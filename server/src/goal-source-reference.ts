import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { analysisComponentKey } from "./analysis-components.js";
import { cleanupSource } from "./video-cleanup/source.js";
import { AUDIO_OPTS, H264_MEDIUM, probeVideo, runFfmpeg } from "./ffmpeg.js";
import { registerMediaProbe } from "./notebook-media-ops.js";
import { placeRenderedCell } from "./jobs/_render-output.js";
import { renderDestination } from "./render-requests.js";
import { withNotebookMutation } from "./notebook-mutations.js";

type SourceReference = { artifactId: string; mediaHash: string; start: number; end: number };
const COMPONENT = { component: "goal-source-reference", version: 1, jobType: "plan_goal" };

export async function prepareGoalSourceReference(engine: Engine, sourceArtifactId: string, atSeconds: number, notebookId: string, signal: AbortSignal): Promise<SourceReference> {
  signal.throwIfAborted();
  const source = await cleanupSource(engine, sourceArtifactId);
  if (source.durationSeconds < 2) throw new Error("H3 Max needs at least two seconds of reference video. Choose a longer source or image references.");
  if (atSeconds < 0 || atSeconds >= source.durationSeconds) throw new Error("The reference timestamp is outside the source video.");
  if (source.durationSeconds <= 15) return { artifactId: sourceArtifactId, mediaHash: source.mediaHash, start: 0, end: source.durationSeconds };
  const frames = Math.floor(15 * source.fps) - 1;
  const duration = frames / source.fps;
  const start = Math.floor(Math.max(0, Math.min(source.durationSeconds - duration, atSeconds - duration / 2)) * source.fps) / source.fps;
  const key = analysisComponentKey(COMPONENT, { sourceHash: source.mediaHash, options: { start, frames, fps: source.fps } });
  return withNotebookMutation(`goal-reference:${key}`, async () => {
    signal.throwIfAborted();
    const cached = engine.settings.get<SourceReference>(`goal.reference.${key}`);
    if (cached) {
      const existing = await cleanupSource(engine, cached.artifactId).catch(() => null);
      if (existing?.mediaHash === cached.mediaHash && existing.durationSeconds >= 2 && existing.durationSeconds <= 15) {
        await placeReference(engine, notebookId, sourceArtifactId, cached.artifactId);
        return cached;
      }
    }
    const created = await engine.artifacts.create("video", "Bounded source reference");
    if (!created.ok) throw new Error(created.error.message);
    const artifactId = created.value.artifactId;
    const workspace = await engine.workspaces.resolveArtifact(artifactId);
    if (!workspace.ok) throw new Error(workspace.error.message);
    const outputPath = join(workspace.value, "reference-scratch.mp4");
    try {
      await runFfmpeg(["-y", "-ss", String(start), "-i", source.path, "-map", "0:v:0", "-map", "0:a:0?", "-t", String(duration),
        "-vf", `setsar=1,fps=${source.fps}`, "-frames:v", String(frames), ...H264_MEDIUM, ...AUDIO_OPTS,
        "-threads", "2", "-movflags", "+faststart", outputPath], { signal });
      const probe = await probeVideo(outputPath, { signal });
      if (probe.videoDuration < 2 || probe.videoDuration > 15 || probe.duration > 15 || probe.hasAudio !== source.hasAudio
        || Math.abs(probe.fps - source.fps) > 0.01 || probe.width !== source.width || probe.height !== source.height) throw new Error("The prepared video reference failed its duration, geometry or audio check.");
      if ((await cleanupSource(engine, sourceArtifactId)).mediaHash !== source.mediaHash) throw new Error("The source changed while preparing its reference.");
      signal.throwIfAborted();
      const written = await engine.files.writeFromPath(artifactId, "original.mp4", outputPath);
      if (!written.ok) throw new Error(written.error.message);
      await registerMediaProbe(engine, artifactId, "original.mp4", probe);
      const provenance = await engine.files.write(artifactId, "goal-reference.json", JSON.stringify({ version: 1, sourceArtifactId, sourceHash: source.mediaHash, start, end: start + duration }));
      if (!provenance.ok) throw new Error(provenance.error.message);
      const prepared = await cleanupSource(engine, artifactId);
      const value = { artifactId, mediaHash: prepared.mediaHash, start, end: start + duration };
      const saved = engine.settings.set(`goal.reference.${key}`, value);
      if (!saved.ok) throw new Error(saved.error.message);
      await placeReference(engine, notebookId, sourceArtifactId, artifactId);
      return value;
    } finally { await rm(outputPath, { force: true }); }
  });
}

async function placeReference(engine: Engine, notebookId: string, sourceArtifactId: string, artifactId: string): Promise<void> {
  await placeRenderedCell(engine, { notebookId, sourceArtifactId, outputArtifactId: artifactId, operation: "goal_reference", fallbackLabel: "Source reference",
    destination: notebook => renderDestination(notebook, sourceArtifactId,
      cell => cell.inputs?.sourceOperation === "goal_reference" && cell.inputs.sourceArtifactId === sourceArtifactId,
      "The notebook needs a free cell for the prepared source reference."),
    inputs: { sourceOperation: "goal_reference", sourceArtifactId },
  });
}
