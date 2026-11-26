import { join } from "node:path";
import { findVideoFile, type Engine } from "videobook-engine";
import { probeVideo } from "./ffmpeg.js";

async function readVideoDurationSeconds(
  engine: Engine,
  artifactId: string,
  probeMissing: boolean,
): Promise<number | undefined> {
  const original = await engine.metadata.artifacts.read<{ duration?: unknown }>(artifactId, "original");
  if (original.ok && typeof original.value?.duration === "number" && Number.isFinite(original.value.duration) && original.value.duration > 0) {
    return original.value.duration;
  }
  if (!probeMissing) return undefined;
  const manifest = await engine.files.manifest(artifactId);
  const videoFile = manifest.ok
    ? manifest.value.files.find((file) => file.name.toLowerCase() === "original.mp4")
      ?? findVideoFile(manifest.value.files)
    : null;
  const streams = engine.streams.list(artifactId);
  if (streams.ok) {
    const matching = videoFile
      ? streams.value.filter((stream) => stream.sourcePath === videoFile.name && stream.objectHash === videoFile.objectHash)
      : streams.value;
    const video = matching.find((stream) => stream.kind === "video" && stream.video);
    if (video && video.timeBase.denominator > 0) {
      const seconds = video.durationTicks * video.timeBase.numerator / video.timeBase.denominator;
      if (Number.isFinite(seconds) && seconds > 0) return seconds;
    }
  }
  if (!manifest.ok || !videoFile) return undefined;
  try {
    const probe = await probeVideo(join(manifest.value.path, videoFile.name));
    const seconds = probe.videoDuration || probe.duration;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
}

export async function referenceVideoDuration(
  engine: Engine,
  refs: readonly string[],
  { probeMissing = false } = {},
): Promise<number | undefined> {
  if (refs.length === 0) return undefined;
  let total = 0;
  for (const ref of refs) {
    const assetId = ref.replace(/^@/, "");
    const artifact = engine.artifacts.get(assetId);
    if (!artifact.ok || artifact.value.kind !== "video") return undefined;
    const duration = await readVideoDurationSeconds(engine, assetId, probeMissing);
    if (duration === undefined) return undefined;
    total += duration;
  }
  return total;
}
