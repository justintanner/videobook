import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findVideoFile, type Engine } from "videobook-engine";
import { probeVideo, runFfmpeg } from "./ffmpeg.js";
import { formatTimestamp, generateTimestamps } from "./frame-utils.js";
import { registerMediaStreams } from "./jobs/process-video.js";

async function prepareSearchFrames(engine: Engine, artifactId: string, signal?: AbortSignal): Promise<void> {
  const streams = engine.streams.list(artifactId);
  if (!streams.ok) throw new Error(streams.error.message);
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw Object.assign(new Error(manifest.error.message), { name: manifest.error.code, error: manifest.error });
  const video = streams.value.find((stream) => stream.kind === "video"
    && manifest.value.files.some((file) => file.name === stream.sourcePath && file.objectHash === stream.objectHash));
  if (!video) return;
  const marker = await engine.metadata.artifacts.read<{ objectHash: string; frames: string[] }>(artifactId, "migrationFrames");
  if (!marker.ok && marker.error.code !== "NOT_FOUND") throw new Error(marker.error.message);
  if (marker.ok && marker.value.objectHash !== video.objectHash) throw new Error("Video changed before its search frames were prepared");
  if (!marker.ok && manifest.value.files.some((file) => /^original_frames\/\d+(?:\.\d+)?\.jpg$/u.test(file.name))) return;
  const duration = video.durationTicks * video.timeBase.numerator / video.timeBase.denominator;
  const frames = marker.ok ? marker.value.frames : generateTimestamps(duration).map((time) => `original_frames/${formatTimestamp(time)}.jpg`);
  if (!marker.ok) {
    const written = await engine.metadata.artifacts.write(artifactId, "migrationFrames", { objectHash: video.objectHash, frames });
    if (!written.ok) throw new Error(written.error.message);
  }
  const existing = new Set(manifest.value.files.map((file) => file.name));
  const temporary = await mkdtemp(join(tmpdir(), "videobook-search-frames-"));
  try {
    for (const name of frames) {
      signal?.throwIfAborted();
      if (!/^original_frames\/\d+(?:\.\d+)?\.jpg$/u.test(name)) throw new Error("Invalid search frame record");
      if (existing.has(name)) continue;
      const target = join(temporary, "frame.jpg");
      await runFfmpeg(["-y", "-ss", name.slice("original_frames/".length, -4),
        "-i", join(manifest.value.path, video.sourcePath), "-map", `0:${video.streamIndex}`, "-frames:v", "1", "-q:v", "2", target], { signal });
      const written = await engine.files.write(artifactId, name, await readFile(target));
      if (!written.ok) throw new Error(written.error.message);
    }
  } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 3 }); }
}

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
  await prepareSearchFrames(engine, artifactId, signal);
}
