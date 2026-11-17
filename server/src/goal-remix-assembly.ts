import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Engine } from "videobook-engine";
import { z } from "zod";
import { AUDIO_OPTS, FFPROBE, H264_MEDIUM, probeVideo, runFfmpeg } from "./ffmpeg.js";
import { remixAssemblyReviewKey, remixAssemblySchema } from "./goal-remix-model.js";
import { shortFinishSource } from "./goal-short-runtime.js";
import { readGoal, requireGoalShortContent, saveGoal, type GoalRecord } from "./goal-store.js";
import { registerMediaProbe } from "./notebook-media-ops.js";
import { withNotebookMutation } from "./notebook-mutations.js";
import { cleanupSource } from "./video-cleanup/source.js";

const execFileAsync = promisify(execFile);
const mediaSchema = z.object({ artifactId: z.string(), mediaHash: z.string() }).strict();
export const goalRemixEditSchema = z.object({
  version: z.literal(1),
  assembly: remixAssemblySchema,
  original: mediaSchema,
  source: mediaSchema,
  clip: mediaSchema,
  startFrame: z.number().int().nonnegative(),
  audio: z.enum(["source", "generated", "mute", "mix"]),
}).strict();
export type GoalRemixEdit = z.infer<typeof goalRemixEditSchema>;
type AssemblyResult = { artifactId: string; mediaHash: string };

export function remixEditIdentity(edit: GoalRemixEdit): string {
  return createHash("sha256").update(JSON.stringify(edit)).digest("hex");
}

export async function reviewShortAction(engine: Engine, goal: GoalRecord, args: Record<string, unknown>): Promise<GoalRecord> {
  if (!["review", "completed", "failed", "interrupted"].includes(goal.status) || goal.finish?.status === "running") throw new Error("Stop the current work before reviewing the action window.");
  const content = requireGoalShortContent(engine, goal);
  if (args.revision !== content.revision) throw new Error("The goal changed. Review the current plan first.");
  const analysis = content.plan?.version === 5 ? content.plan.analysis : null;
  const assembly = analysis?.recipe.assembly;
  if (!analysis || !assembly) throw new Error("This goal has no preserved-source action interval.");
  if (args.confirmed !== true) throw new Error("Confirm that the retained window contains the complete action and payoff.");
  const selected = await shortFinishSource(engine, goal);
  if (args.artifact_id !== selected) throw new Error("Review the currently selected take.");
  const clip = await cleanupSource(engine, selected);
  if (args.media_hash !== clip.mediaHash) throw new Error("The generated clip changed. Review its current media hash.");
  const startSeconds = z.number().nonnegative().parse(args.start_seconds);
  const startFrame = Math.round(startSeconds * assembly.fps);
  const endFrame = startFrame + assembly.changeEndFrame - assembly.changeStartFrame;
  if (endFrame > Math.floor(clip.durationSeconds * assembly.fps + 0.0001)) {
    throw new Error("The retained action window extends past the generated clip. Choose an earlier start or regenerate a complete action.");
  }
  const latest = readGoal(engine, goal.goalId);
  if (latest.status !== goal.status || requireGoalShortContent(engine, latest).revision !== content.revision) throw new Error("The goal changed during action review.");
  const previous = latest.actionWindow;
  if (previous?.artifactId === selected && previous.mediaHash === clip.mediaHash && previous.recipeKey === remixAssemblyReviewKey(analysis)
    && previous.startFrame === startFrame && previous.endFrame === endFrame) return latest;
  return saveGoal(engine, { ...latest, status: "review", finish: null, actionWindow: {
    artifactId: selected, mediaHash: clip.mediaHash, recipeKey: remixAssemblyReviewKey(analysis), startFrame, endFrame,
    durationSeconds: clip.durationSeconds, reviewedAt: new Date().toISOString(),
  } });
}

export async function bindGoalRemixEdit(engine: Engine, goal: GoalRecord, clipArtifactId: string): Promise<GoalRemixEdit | null> {
  const plan = requireGoalShortContent(engine, goal).plan;
  const analysis = plan?.version === 5 ? plan.analysis : null;
  if (!analysis?.recipe.assembly) return null;
  const { recipe, source } = analysis;
  const window = goal.actionWindow;
  if (!window || window.artifactId !== clipArtifactId || window.recipeKey !== remixAssemblyReviewKey(analysis)
    || window.endFrame - window.startFrame !== recipe.assembly!.changeEndFrame - recipe.assembly!.changeStartFrame) {
    throw new Error("Review the retained action window before finishing. Include the entire action and payoff; provider overrun is not trimmed automatically.");
  }
  if (!source || !recipe.preparedArtifactId || !recipe.preparedMediaHash || recipe.cleanupReviewedHash !== recipe.preparedMediaHash) throw new Error("Prepare and review the source before assembly.");
  const edit = goalRemixEditSchema.parse({
    version: 1, assembly: recipe.assembly, original: { artifactId: source.artifactId, mediaHash: source.mediaHash },
    source: { artifactId: recipe.preparedArtifactId, mediaHash: recipe.preparedMediaHash },
    clip: { artifactId: clipArtifactId, mediaHash: window.mediaHash }, startFrame: window.startFrame, audio: analysis.intent.audio,
  });
  await assertRemixEditSources(engine, edit);
  return edit;
}

export async function assertRemixEditSources(engine: Engine, edit: GoalRemixEdit): Promise<void> {
  for (const expected of [edit.original, edit.source, edit.clip]) {
    const source = await cleanupSource(engine, expected.artifactId);
    if (source.mediaHash !== expected.mediaHash) throw new Error("A reviewed assembly input changed. Review the source and action window again.");
  }
}

function assemblyFilters(edit: GoalRemixEdit, sourceAudio: boolean, clipAudio: boolean): { graph: string; audio: boolean } {
  const { fps, width, height, totalFrames, changeStartFrame: start, changeEndFrame: end } = edit.assembly;
  const frames = end - start;
  const kept = [start > 0 ? { start: 0, end: start } : null, end < totalFrames ? { start: end, end: totalFrames } : null].filter(value => value !== null);
  const filters: string[] = [];
  if (kept.length > 0) filters.push(`[0:v]fps=${fps},setsar=1,split=${kept.length}${kept.map((_, index) => `[source${index}]`).join("")}`);
  kept.forEach((range, index) => filters.push(`[source${index}]trim=start_frame=${range.start}:end_frame=${range.end},setpts=PTS-STARTPTS[keep${index}]`));
  filters.push(`[1:v]fps=${fps},trim=start_frame=${edit.startFrame}:end_frame=${edit.startFrame + frames},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[action]`);
  const segments = [start > 0 ? "[keep0]" : "", "[action]", end < totalFrames ? `[keep${kept.length - 1}]` : ""].filter(Boolean);
  filters.push(`${segments.join("")}concat=n=${segments.length}:v=1:a=0,setsar=1[outv]`);
  const duration = totalFrames / fps;
  const original = sourceAudio && (edit.audio === "source" || edit.audio === "mix");
  const generated = clipAudio && (edit.audio === "generated" || edit.audio === "mix");
  if (original) filters.push(`[0:a]aresample=48000,asetpts=PTS-STARTPTS,apad,atrim=end=${duration}[originalaudio]`);
  if (generated) filters.push(`[1:a]aresample=48000,atrim=start=${edit.startFrame / fps}:end=${(edit.startFrame + frames) / fps},asetpts=PTS-STARTPTS,adelay=${Math.round(start / fps * 48000)}S:all=1,apad,atrim=end=${duration}[generatedaudio]`);
  if (original && generated) filters.push("[originalaudio][generatedaudio]amix=inputs=2:duration=longest:normalize=0[outa]");
  else if (original || generated) filters.push(`[${original ? "originalaudio" : "generatedaudio"}]anull[outa]`);
  return { graph: filters.join(";"), audio: original || generated };
}

export async function validateRemixAssembly(path: string, edit: GoalRemixEdit, signal: AbortSignal): Promise<Awaited<ReturnType<typeof probeVideo>>> {
  const probe = await probeVideo(path, { signal });
  const { stdout } = await execFileAsync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path], { signal, timeout: 120_000, killSignal: "SIGKILL" });
  const { fps, width, height, totalFrames } = edit.assembly;
  if (Number(stdout.trim()) !== totalFrames || probe.width !== width || probe.height !== height || Math.abs(probe.fps - fps) > 0.001
    || Math.abs(probe.videoDuration - totalFrames / fps) > 0.002) throw new Error("The assembled video failed its frame count, duration, frame rate or geometry check.");
  await runFfmpeg(["-v", "error", "-xerror", "-i", path, "-map", "0:v:0", "-map", "0:a:0?", "-f", "null", "-"], { signal });
  return probe;
}

export async function renderGoalRemixAssembly(engine: Engine, edit: GoalRemixEdit, signal: AbortSignal): Promise<AssemblyResult> {
  const identity = remixEditIdentity(edit);
  return withNotebookMutation(`goal-assembly:${identity}`, async () => {
    signal.throwIfAborted();
    await assertRemixEditSources(engine, edit);
    const key = `goal.assembly.${identity}`;
    const cached = engine.settings.get<AssemblyResult>(key);
    if (cached) {
      const current = await cleanupSource(engine, cached.artifactId).catch(() => null);
      if (current?.mediaHash === cached.mediaHash) return cached;
    }
    const source = await cleanupSource(engine, edit.source.artifactId);
    const clip = await cleanupSource(engine, edit.clip.artifactId);
    const { fps, totalFrames, changeStartFrame: start, changeEndFrame: end } = edit.assembly;
    if (source.width !== edit.assembly.width || source.height !== edit.assembly.height || Math.abs(source.fps - fps) > 0.001) throw new Error("The prepared source no longer matches the assembly geometry or frame rate.");
    if ((end < totalFrames ? totalFrames : start) > Math.floor(source.durationSeconds * fps + 0.0001)) throw new Error("The source is missing frames required by the kept ranges.");
    if (edit.startFrame + end - start > Math.floor(clip.durationSeconds * fps + 0.0001)) throw new Error("The generated clip is missing frames from the reviewed action window.");
    if ((edit.audio === "source" || edit.audio === "mix") && !source.hasAudio) throw new Error("The source has no soundtrack. Choose generated sound or mute before finishing.");
    const created = await engine.artifacts.create("video", "Assembled remix");
    if (!created.ok) throw new Error(created.error.message);
    const artifactId = created.value.artifactId;
    const workspace = await engine.workspaces.resolveArtifact(artifactId);
    if (!workspace.ok) throw new Error(workspace.error.message);
    const outputPath = join(workspace.value, "assembly-scratch.mp4");
    try {
      const filter = assemblyFilters(edit, source.hasAudio, clip.hasAudio);
      await runFfmpeg(["-y", "-i", source.path, "-i", clip.path, "-filter_complex_threads", "1", "-filter_complex", filter.graph,
        "-map", "[outv]", ...(filter.audio ? ["-map", "[outa]"] : ["-an"]), ...H264_MEDIUM,
        ...(filter.audio ? AUDIO_OPTS : []), "-r", String(fps), "-threads", "2", "-movflags", "+faststart", outputPath], { signal });
      const probe = await validateRemixAssembly(outputPath, edit, signal);
      await assertRemixEditSources(engine, edit);
      signal.throwIfAborted();
      const written = await engine.files.writeFromPath(artifactId, "original.mp4", outputPath);
      if (!written.ok) throw new Error(written.error.message);
      await registerMediaProbe(engine, artifactId, "original.mp4", probe, { transcribe: false });
      const result = { artifactId, mediaHash: (await cleanupSource(engine, artifactId)).mediaHash };
      const provenance = await engine.files.write(artifactId, "goal-assembly.json", JSON.stringify({ ...edit, identity, outputHash: result.mediaHash }));
      if (!provenance.ok) throw new Error(provenance.error.message);
      const saved = engine.settings.set(key, result);
      if (!saved.ok) throw new Error(saved.error.message);
      return result;
    } finally { await rm(outputPath, { force: true }); }
  });
}
