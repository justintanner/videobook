import { findVideoFile, type Engine } from "videobook-engine";
import { join } from "node:path";
import { prepareMigrationFrames } from "./migration-media.js";
import { probeVideo } from "./ffmpeg.js";
import { registerMediaStreams } from "./jobs/process-video.js";

export async function prepareSearchVideo(engine: Engine, artifactId: string, signal: AbortSignal): Promise<void> {
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = findVideoFile(manifest.value.files);
  if (!file) throw new Error("No video source is available for indexing");
  const streams = engine.streams.list(artifactId);
  if (!streams.ok) throw new Error(streams.error.message);
  if (!streams.value.some((stream) => stream.kind === "video" && stream.objectHash === file.objectHash)) {
    const probe = await probeVideo(join(manifest.value.path, file.name), { signal });
    if (!probe.videoStream) throw new Error("No usable video stream is available for indexing");
    await registerMediaStreams(engine, artifactId, file.name, probe);
  }
  await prepareMigrationFrames(engine, artifactId, signal);
}
