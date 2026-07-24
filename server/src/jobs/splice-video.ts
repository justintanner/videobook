import type { Engine } from "videobook-engine";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { registerJobHandler, queue } from "../queue.js";
import { runFfmpeg, FFMPEG, H264_MEDIUM, AUDIO_OPTS, probeVideo } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";
import { ingestWorkspaceOutputs } from "./_persist-output.js";

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
  bookId: string;
  targetWidth: number;
  targetHeight: number;
  firstFps: number;
  firstDuration?: number;
  firstHasAudio: boolean;
  secondHasAudio: boolean;
  overlap?: number;
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
  startFrame: number,
): Promise<MatchResult> {
  const startTime = startFrame / fps;
  const proc = spawn(FFMPEG, [
    ...(startFrame > 0 ? ["-ss", String(startTime)] : []),
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
    frameIndex: startFrame + bestIndex,
    timestamp: startTime + bestIndex / fps,
    score: bestScore / MATCH_FRAME_BYTES,
  };
}

async function spliceConcat(
  firstPath: string,
  secondPath: string,
  splicePoint: number | null,
  outputPath: string,
  width: number,
  height: number,
  fps: number,
  withAudio: boolean,
): Promise<void> {
  const scalePad = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const firstVideo = splicePoint === null
    ? `[0:v]fps=${fps},${scalePad},setpts=PTS-STARTPTS[v0]`
    : `[0:v]trim=end=${splicePoint},fps=${fps},${scalePad},setpts=PTS-STARTPTS[v0]`;
  const filterParts: string[] = [
    firstVideo,
    `[1:v]fps=${fps},${scalePad},setpts=PTS-STARTPTS[v1]`,
  ];

  if (withAudio) {
    const firstAudio = splicePoint === null
      ? `[0:a]asetpts=PTS-STARTPTS[a0]`
      : `[0:a]atrim=end=${splicePoint},asetpts=PTS-STARTPTS[a0]`;
    filterParts.push(firstAudio);
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

export type SpliceFilesResult = {
  timestamp: number;
  frameIndex: number | null;
  score: number | null;
};

export type SpliceFilesOptions = {
  firstPath: string;
  secondPath: string;
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  firstDuration: number;
  withAudio: boolean;
  overlap: number;
};

export async function spliceVideoFiles(options: SpliceFilesOptions): Promise<SpliceFilesResult> {
  const {
    firstPath,
    secondPath,
    outputPath,
    width,
    height,
    fps,
    firstDuration,
    withAudio,
    overlap,
  } = options;
  if (!Number.isFinite(firstDuration) || firstDuration <= 0) {
    throw new Error(`Invalid first video duration: ${firstDuration}`);
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`Invalid first video frame rate: ${fps}`);
  }
  if (!Number.isFinite(overlap) || overlap < 0) {
    throw new Error(`Overlap must be a non-negative number, got: ${overlap}`);
  }

  if (overlap === 0) {
    await spliceConcat(
      firstPath,
      secondPath,
      null,
      outputPath,
      width,
      height,
      fps,
      withAudio,
    );
    return { timestamp: firstDuration, frameIndex: null, score: null };
  }

  const minimumWindow = 1 / fps;
  const searchStart = Math.max(0, firstDuration - Math.max(overlap, minimumWindow));
  const startFrame = Math.floor(searchStart * fps);
  const target = await extractTargetFrame(secondPath);
  const match = await findBestMatch(firstPath, target, fps, startFrame);
  await spliceConcat(
    firstPath,
    secondPath,
    match.timestamp,
    outputPath,
    width,
    height,
    fps,
    withAudio,
  );
  return match;
}

export function registerSpliceVideoJob(fs: Engine): void {
  registerJobHandler("splice_video", async (payload, ctx) => {
    const {
      firstPath, secondPath, outputPath,
      firstAssetId, secondAssetId,
      assetId, assetDir, bookId,
      targetWidth, targetHeight, firstFps, firstDuration,
      firstHasAudio, secondHasAudio,
      overlap,
    } = payload as SpliceVideoPayload;

    const result = await withLockedLocalLease(
      fs,
      bookId,
      assetId,
      assetDir,
      ctx,
      "splice",
      { durationMs: LOCK_DURATION_MS, data: { state: "splicing" } },
      async () => {
      const resolvedFirstDuration = typeof firstDuration === "number"
        ? firstDuration
        : (await probeVideo(firstPath)).videoDuration;
      const resolvedOverlap = typeof overlap === "number" ? overlap : resolvedFirstDuration;
      const withAudio = firstHasAudio && secondHasAudio;
      const splice = await spliceVideoFiles({
        firstPath,
        secondPath,
        outputPath,
        width: targetWidth,
        height: targetHeight,
        fps: firstFps,
        firstDuration: resolvedFirstDuration,
        withAudio,
        overlap: resolvedOverlap,
      });

      const provenance = {
        origin: "splice",
        first_asset: firstAssetId,
        second_asset: secondAssetId,
        overlap_seconds: resolvedOverlap,
        splice_timestamp: splice.timestamp,
        match_frame_index: splice.frameIndex,
        match_score: splice.score,
        spliced_at: new Date().toISOString(),
      };
      await ingestWorkspaceOutputs(
        fs,
        bookId,
        assetId,
        [outputPath.split("/").pop()!],
        "splice_video",
        provenance,
      );
      await fs.metadata.artifacts.write(assetId, "original", provenance);

      return { provenance, timestamp: splice.timestamp, score: splice.score };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    const processJobId = `process-video-${assetId}-${Date.now()}`;
    await queue.enqueue(processJobId, {
      type: "process_video",
      videoPath: outputPath,
      assetId,
      assetDir,
      bookId,
      provenance: result.provenance,
    } as unknown as Record<string, unknown>);

    return { success: true, splice_timestamp: result.timestamp, match_score: result.score };
  });
}
