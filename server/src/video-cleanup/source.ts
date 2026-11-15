import type { Engine } from "videobook-engine";
import { captionMediaSource } from "../captions/source.js";
import { probeVideo } from "../ffmpeg.js";

export async function cleanupSource(engine: Engine, artifactId: string) {
  const source = await captionMediaSource(engine, artifactId);
  const probe = await probeVideo(source.path);
  const fps = probe.avgFps ?? probe.fps;
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw new Error("Video removal needs a measurable frame rate of up to 240 fps.");
  return { ...source, fps };
}
