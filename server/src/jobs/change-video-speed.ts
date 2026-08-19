import type { Engine } from "videobook-engine";
import { basename, join } from "node:path";
import { registerJobHandler, queue } from "../queue.js";
import { getFFmpeggy, H264_MEDIUM, AUDIO_OPTS } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";

const LOCK_DURATION_MS = 300_000;
const ATEMPO_MIN = 0.5;

function buildAtempoChain(speed: number): string[] {
  const filters: string[] = [];
  let remaining = speed;
  while (remaining < ATEMPO_MIN) {
    filters.push(`atempo=${ATEMPO_MIN}`);
    remaining /= ATEMPO_MIN;
  }
  filters.push(`atempo=${remaining}`);
  return filters;
}

function buildSpeedOutputOptions(speed: number, hasAudio: boolean): string[] {
  const videoFilter = `setpts=PTS/${speed}`;
  const opts = ["-filter:v", videoFilter];
  if (hasAudio) {
    const atempoChain = buildAtempoChain(speed);
    opts.push("-filter:a", atempoChain.join(","));
  } else {
    opts.push("-an");
  }
  opts.push(...H264_MEDIUM, ...AUDIO_OPTS);
  return opts;
}

type ChangeVideoSpeedPayload = {
  type: "change_video_speed";
  inputPath: string;
  outputPath: string;
  speed: number;
  targetDuration?: number;
  hasAudio: boolean;
  assetId: string;
  assetDir: string;
  bookId: string;
};

export function registerChangeVideoSpeedJob(engine: Engine): void {
  registerJobHandler("change_video_speed", async (payload, ctx) => {
    const {
      inputPath, outputPath, speed, targetDuration, hasAudio,
      assetId, assetDir, bookId,
    } = payload as ChangeVideoSpeedPayload;

    const result = await withLockedLocalLease(
      engine,
      assetId,
      assetDir,
      ctx,
      "change_speed",
      { durationMs: LOCK_DURATION_MS, data: { state: "changing-speed" } },
      async () => {
      const outputOptions = buildSpeedOutputOptions(speed, hasAudio);
      if (targetDuration !== undefined) {
        outputOptions.push("-t", targetDuration.toFixed(6));
      }
      const FFmpeggy = await getFFmpeggy();
      const ff = new FFmpeggy({
        input: inputPath,
        output: outputPath,
        outputOptions,
        overwriteExisting: true,
      });

      await ff.run();
      await ff.done();

      const inputFilename = basename(inputPath);
      await replaceArtifactFileFromPath(
        engine,
        assetId,
        inputFilename,
        outputPath,
      );

      const videoPath = join(assetDir, inputFilename);
      return { videoPath };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
      type: "process_video",
      videoPath: result.videoPath,
      assetId,
      assetDir,
      bookId,
      provenance: {
        origin: "speed_change",
        source_asset_id: assetId,
        speed,
        targetDuration,
        speed_changed_at: new Date().toISOString(),
      },
      force: true,
      skipDownstreamJobs: true,
    } as unknown as Record<string, unknown>);

    return { success: true };
  });
}
