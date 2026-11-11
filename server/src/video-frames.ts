import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findVideoFile, type Engine } from "videobook-engine";
import { probeVideo, runFfmpeg } from "./ffmpeg.js";
import { formatTimestamp, generateTimestamps } from "./frame-utils.js";

const FRAMES_DIR = "original_frames";
const SCRATCH_PREFIX = "videobook-video-frames-";

function isStoredFrame(name: string): boolean {
  return name.startsWith(`${FRAMES_DIR}/`) && name.endsWith(".jpg");
}

async function extractFrame(videoPath: string, seconds: number, target: string, signal?: AbortSignal): Promise<Buffer | null> {
  try {
    await runFfmpeg(["-y", "-ss", String(seconds), "-i", videoPath, "-frames:v", "1", "-q:v", "2", "-strict", "unofficial", target], { signal });
    return await readFile(target);
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

export async function ensureVideoFrames(engine: Engine, assetId: string, signal?: AbortSignal): Promise<void> {
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  if (manifest.value.files.some((file) => isStoredFrame(file.name))) return;
  const video = findVideoFile(manifest.value.files.filter((file) => file.name !== "proxy.mp4"));
  if (!video) return;
  const videoPath = join(manifest.value.path, video.name);
  const probe = await probeVideo(videoPath, { signal });
  const duration = probe.videoDuration > 0 ? probe.videoDuration : probe.duration;
  const scratch = await mkdtemp(join(tmpdir(), SCRATCH_PREFIX));
  try {
    for (const seconds of generateTimestamps(duration)) {
      const name = `${formatTimestamp(seconds)}.jpg`;
      const frame = await extractFrame(videoPath, seconds, join(scratch, name), signal);
      if (!frame) continue;
      const written = await engine.files.write(assetId, `${FRAMES_DIR}/${name}`, frame);
      if (!written.ok) throw new Error(written.error.message);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
