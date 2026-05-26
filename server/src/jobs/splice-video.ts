import type { VideocityFs } from "vc-engine";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { registerJobHandler, queue } from "../queue.js";
import { runFfmpeg, FFMPEG, H264_MEDIUM, AUDIO_OPTS } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";

const execFileAsync = promisify(execFile);

const LOCK_DURATION_MS = 1_800_000;

// Downsampled grayscale resolution used for both the target reference frame
// and the scanned frames in video1. Small enough to keep the inner MAE loop
// cheap (~4k bytes/frame) and to bound memory; large enough to discriminate
// between visually distinct frames.
const MATCH_W = 64;
const MATCH_H = 64;
const MATCH_FRAME_BYTES = MATCH_W * MATCH_H;

type SpliceVideoPayload = {
  type: "splice_video";
  firstPath: string;
  secondPath: string;
  outputPath: string;
  firstAssetId: string;
  secondAssetId: string;
  assetId: string;
  assetDir: string;
  projectSlug: string;
  targetWidth: number;
  targetHeight: number;
  firstFps: number;
  firstHasAudio: boolean;
  secondHasAudio: boolean;
};

async function extractTargetFrame(videoPath: string): Promise<Buffer> {
  const { stdout } = await execFileAsync(FFMPEG, [
    "-y",
    "-i", videoPath,
    "-vf", `scale=${MATCH_W}:${MATCH_H},format=gray`,
    "-frames:v", "1",
    "-an",
    "-f", "rawvideo",
    "-pix_fmt", "gray",
    "pipe:1",
  ], { encoding: "buffer", maxBuffer: 1024 * 1024 });
  const buf = stdout as unknown as Buffer;
  if (buf.length < MATCH_FRAME_BYTES) {
    throw new Error(
      `Target frame extraction returned ${buf.length} bytes, expected ${MATCH_FRAME_BYTES}`,
    );
  }
  return buf.subarray(0, MATCH_FRAME_BYTES);
}

interface MatchResult {
  frameIndex: number;
  timestamp: number;
  score: number;
}

async function findBestMatch(
  videoPath: string,
  target: Buffer,
  fps: number,
): Promise<MatchResult> {
  const proc = spawn(FFMPEG, [
    "-i", videoPath,
    "-vf", `fps=${fps},scale=${MATCH_W}:${MATCH_H},format=gray`,
    "-an",
    "-f", "rawvideo",
    "-pix_fmt", "gray",
    "pipe:1",
  ], { stdio: ["ignore", "pipe", "ignore"] });

  let buffer: Buffer = Buffer.alloc(0);
  let frameIndex = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestIndex = -1;

  for await (const chunk of proc.stdout!) {
    const incoming = chunk as Buffer;
    buffer = buffer.length === 0 ? incoming : Buffer.concat([buffer, incoming]);
    while (buffer.length >= MATCH_FRAME_BYTES) {
      let score = 0;
      for (let i = 0; i < MATCH_FRAME_BYTES; i++) {
        const d = buffer[i] - target[i];
        score += d < 0 ? -d : d;
      }
      if (score < bestScore) {
        bestScore = score;
        bestIndex = frameIndex;
      }
      buffer = buffer.subarray(MATCH_FRAME_BYTES);
      frameIndex++;
    }
  }

  await new Promise<void>((resolve, reject) => {
    proc.on("close", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`ffmpeg search exited with code ${code}`));
    });
    proc.on("error", reject);
  });

  if (bestIndex < 0) throw new Error(`No frames decoded from ${videoPath}`);

  return {
    frameIndex: bestIndex,
    timestamp: bestIndex / fps,
    score: bestScore / MATCH_FRAME_BYTES,
  };
}

async function spliceConcat(
  firstPath: string,
  secondPath: string,
  splicePoint: number,
  outputPath: string,
  width: number,
  height: number,
  fps: number,
  withAudio: boolean,
): Promise<void> {
  // Cut first video at splicePoint (exclusive); second video plays from start.
  // Both streams are scaled+padded to the first video's dimensions and SAR
  // normalized so concat=n=2 doesn't error on aspect-ratio or dimension mismatch.
  // The `fps` filter normalizes frame rate across inputs — without it, mismatched
  // input rates produce a degenerate output timebase that makes libx264 attempt
  // to encode at billions of frames per second.
  const scalePad = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const filterParts: string[] = [
    `[0:v]trim=end=${splicePoint},fps=${fps},${scalePad},setpts=PTS-STARTPTS[v0]`,
    `[1:v]fps=${fps},${scalePad},setpts=PTS-STARTPTS[v1]`,
  ];

  if (withAudio) {
    filterParts.push(`[0:a]atrim=end=${splicePoint},asetpts=PTS-STARTPTS[a0]`);
    filterParts.push(`[1:a]asetpts=PTS-STARTPTS[a1]`);
    filterParts.push(`[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`);
  } else {
    filterParts.push(`[v0][v1]concat=n=2:v=1:a=0[v]`);
  }

  const args = [
    "-y",
    "-i", firstPath,
    "-i", secondPath,
    "-filter_complex", filterParts.join(";"),
    "-map", "[v]",
    ...(withAudio ? ["-map", "[a]"] : []),
    ...H264_MEDIUM,
    ...(withAudio ? AUDIO_OPTS : []),
    outputPath,
  ];
  await runFfmpeg(args);
}

export function registerSpliceVideoJob(fs: VideocityFs): void {
  registerJobHandler("splice_video", async (payload, ctx) => {
    const {
      firstPath, secondPath, outputPath,
      firstAssetId, secondAssetId,
      assetId, assetDir, projectSlug,
      targetWidth, targetHeight, firstFps,
      firstHasAudio, secondHasAudio,
    } = payload as SpliceVideoPayload;

    const result = await withLockedLocalLease(
      fs,
      projectSlug,
      assetId,
      assetDir,
      ctx,
      "splice",
      { durationMs: LOCK_DURATION_MS, data: { state: "splicing" } },
      async () => {
      const target = await extractTargetFrame(secondPath);
      const match = await findBestMatch(firstPath, target, firstFps);

      const withAudio = firstHasAudio && secondHasAudio;
      await spliceConcat(
        firstPath, secondPath, match.timestamp,
        outputPath, targetWidth, targetHeight, firstFps, withAudio,
      );

      const provenance = {
        origin: "splice",
        first_asset: firstAssetId,
        second_asset: secondAssetId,
        splice_timestamp: match.timestamp,
        match_frame_index: match.frameIndex,
        match_score: match.score,
        spliced_at: new Date().toISOString(),
      };
      await fs.writeMetadata(assetId, "original", provenance, projectSlug);

      return { provenance, timestamp: match.timestamp, score: match.score };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    const processJobId = `process-video-${assetId}-${Date.now()}`;
    await queue.enqueue(processJobId, {
      type: "process_video",
      videoPath: outputPath,
      assetId,
      assetDir,
      projectSlug,
      provenance: result.provenance,
    } as unknown as Record<string, unknown>);

    return { success: true, splice_timestamp: result.timestamp, match_score: result.score };
  });
}
