import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { coldOpenSource } from "./cold-open.js";
import { AUDIO_OPTS, probeVideo, runFfmpeg } from "./ffmpeg.js";
import type { GoalBranding, GoalFinishRecipe } from "./goal-finish-model.js";
import { goalBrandingDocument } from "./goal-finish-model.js";
import { assertGoalBrandingCurrent, goalSoundtrackSource } from "./goal-finish-settings.js";
import type { ShortFinishTitle } from "./goal-short-plan.js";
import { burnGraphics, graphicsBurnFrame } from "./graphics/burn.js";
import { graphicsDocumentImages } from "./graphics/images.js";
import { renderGraphicsStills } from "./graphics/render-stills.js";
import { replaceArtifactFileFromPath } from "./jobs/_persist-output.js";
import { registerMediaProbe } from "./notebook-media-ops.js";

export async function assertGoalFinishRecipe(engine: Engine, recipe: GoalFinishRecipe): Promise<void> {
  if (recipe.branding) await assertGoalBrandingCurrent(engine, recipe.branding);
  if (recipe.audio !== "source" && recipe.audio !== "mix") return;
  if (!recipe.soundtrack?.hasAudio) throw new Error("The selected soundtrack has no audio. Choose generated sound, mute, or another soundtrack before finishing.");
  const source = await goalSoundtrackSource(engine, recipe.soundtrack.artifactId, recipe.soundtrack.mediaHash, recipe.soundtrack);
  if (!source.hasAudio || recipe.soundtrack.startSeconds >= source.durationSeconds) throw new Error("The selected soundtrack has no audio at its chosen start. Review its finish settings.");
}

export async function renderGoalFinishAudio(engine: Engine, artifactId: string, recipe: GoalFinishRecipe, signal: AbortSignal): Promise<void> {
  await assertGoalFinishRecipe(engine, recipe);
  if (recipe.audio === "generated") return;
  const video = await coldOpenSource(engine, artifactId);
  const probe = await probeVideo(video.path, { signal });
  const soundtrack = recipe.audio === "source" || recipe.audio === "mix" ? recipe.soundtrack : null;
  const audio = soundtrack ? await goalSoundtrackSource(engine, soundtrack.artifactId, soundtrack.mediaHash, soundtrack) : null;
  const filters = audio && soundtrack ? [`[1:a:0]aresample=48000:async=1:first_pts=0,atrim=start=${soundtrack.startSeconds},asetpts=PTS-STARTPTS,apad,atrim=end=${probe.videoDuration}[sourceaudio]`] : [];
  if (audio && recipe.audio === "mix" && probe.hasAudio) {
    filters.push(`[0:a:0]aresample=48000,asetpts=PTS-STARTPTS,apad,atrim=end=${probe.videoDuration}[generatedaudio]`, "[sourceaudio][generatedaudio]amix=inputs=2:duration=longest:normalize=0[outa]");
  } else if (audio) filters.push("[sourceaudio]anull[outa]");
  const workspace = await engine.workspaces.resolveArtifact(artifactId);
  if (!workspace.ok) throw new Error(workspace.error.message);
  const outputPath = join(workspace.value, "finish-audio-scratch.mp4");
  try {
    await runFfmpeg(["-y", "-i", video.path, ...(audio ? ["-i", audio.path] : []),
      ...(filters.length ? ["-filter_complex_threads", "1", "-filter_complex", filters.join(";")] : []),
      "-map", "0:v:0", "-c:v", "copy", ...(audio ? ["-map", "[outa]", ...AUDIO_OPTS] : ["-an"]),
      "-movflags", "+faststart", outputPath], { signal });
    await assertGoalFinishRecipe(engine, recipe);
    signal.throwIfAborted();
    const rendered = await probeVideo(outputPath, { signal });
    await replaceArtifactFileFromPath(engine, artifactId, video.file.name, outputPath);
    await registerMediaProbe(engine, artifactId, video.file.name, rendered, { transcribe: false });
  } finally { await rm(outputPath, { force: true }); }
}

export async function renderGoalFinishBranding(engine: Engine, artifactId: string, branding: GoalBranding, title: ShortFinishTitle | null, signal: AbortSignal): Promise<void> {
  await assertGoalBrandingCurrent(engine, branding);
  const source = await coldOpenSource(engine, artifactId);
  const probe = await probeVideo(source.path, { signal });
  const frame = graphicsBurnFrame(probe);
  const document = goalBrandingDocument(branding, title, probe.videoDuration, frame);
  const workspace = await engine.workspaces.resolveArtifact(artifactId);
  if (!workspace.ok) throw new Error(workspace.error.message);
  const scratch = join(workspace.value, "finish-branding-scratch");
  try {
    const { groups } = await renderGraphicsStills({ document, frame, durationSeconds: probe.videoDuration, fps: probe.fps,
      images: await graphicsDocumentImages(engine, document, probe.videoDuration), outputDir: scratch, signal });
    if (!groups.length) return;
    const outputPath = join(scratch, "finished.mp4");
    await burnGraphics({ videoPath: source.path, outputPath, stills: groups, probe, signal });
    await assertGoalBrandingCurrent(engine, branding);
    signal.throwIfAborted();
    const rendered = await probeVideo(outputPath, { signal });
    await replaceArtifactFileFromPath(engine, artifactId, source.file.name, outputPath);
    await registerMediaProbe(engine, artifactId, source.file.name, rendered, { transcribe: false });
    const written = await engine.files.write(artifactId, "graphics.json", JSON.stringify(document));
    if (!written.ok) throw new Error(written.error.message);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
