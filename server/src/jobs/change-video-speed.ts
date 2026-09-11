import type { Engine } from "videobook-engine";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, join } from "node:path";
import { registerJobHandler, queue } from "../queue.js";
import {
  getFFmpeggy,
  probeVideo,
  FFPROBE,
  H264_MEDIUM,
  AUDIO_OPTS,
  type ProbeResult,
} from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";

const execFileAsync = promisify(execFile);

const LOCK_DURATION_MS = 300_000;
const ATEMPO_MIN = 0.5;
// The muxer can pad the final frame's display duration past the ideal end
// (observed: 1.5 source frame intervals on B-frame sources); keep the
// duration check as a backstop and let frame-count equality carry precision.
const DURATION_FRAME_TOLERANCE = 1.5;
const DURATION_SLACK_S = 0.03;
const AUDIO_TOLERANCE_S = 0.15;

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

function buildSpeedOutputOptions(
  speed: number,
  hasAudio: boolean,
  targetDuration?: number,
  outputFrameRate?: number,
): string[] {
  const videoChain = [`settb=AVTB`, `setpts=(PTS-STARTPTS)/${speed}`];
  const audioChain = ["asetpts=PTS-STARTPTS", ...buildAtempoChain(speed)];
  if (targetDuration !== undefined) {
    const cap = targetDuration.toFixed(6);
    videoChain.push(`trim=end=${cap}`);
    audioChain.push(`atrim=end=${cap}`);
  }
  const opts = [
    "-fps_mode:v", outputFrameRate === undefined ? "passthrough" : "cfr",
    ...(outputFrameRate === undefined ? [] : ["-r", String(outputFrameRate)]),
    "-filter:v", videoChain.join(","),
  ];
  if (hasAudio) {
    opts.push("-filter:a", audioChain.join(","));
  } else {
    opts.push("-an");
  }
  opts.push(...H264_MEDIUM, ...AUDIO_OPTS);
  return opts;
}

async function probeVideoFrameCount(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(FFPROBE, [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=nb_frames",
      "-of", "json",
      filePath,
    ]);
    const data = JSON.parse(stdout) as { streams?: Array<{ nb_frames?: unknown }> };
    const count = Number(data.streams?.[0]?.nb_frames);
    return Number.isSafeInteger(count) && count > 0 ? count : null;
  } catch {
    return null;
  }
}

async function hasConstantFrameSpacing(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(FFPROBE, [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "packet=pts",
      "-of", "json",
      filePath,
    ], { maxBuffer: 16 * 1024 * 1024 });
    const data = JSON.parse(stdout) as { packets?: Array<{ pts?: unknown }> };
    const times = data.packets?.map((packet) => Number(packet.pts)) ?? [];
    if (times.length < 2 || times.some((time) => !Number.isSafeInteger(time))) return false;
    times.sort((a, b) => a - b);
    const interval = (times[times.length - 1] - times[0]) / (times.length - 1);
    return interval > 0 && times.slice(1).every((time, index) => (
      time > times[index] && Math.abs(time - times[index] - interval) <= 1
    ));
  } catch {
    return false;
  }
}

function retimeValidationErrors(
  input: ProbeResult,
  output: ProbeResult,
  speed: number,
  targetDuration: number | undefined,
): string[] {
  const errors: string[] = [];
  if (output.videoCodec === null || output.videoDuration <= 0) {
    errors.push("output has no playable video stream");
    return errors;
  }
  // In exact-duration mode the trim/atrim cap wins when a stream would
  // overrun the target, so expectations clamp to the cap.
  const cap = targetDuration ?? Number.POSITIVE_INFINITY;
  const frameInterval = input.fps > 0 ? 1 / input.fps : 1 / 30;
  const videoTolerance = DURATION_FRAME_TOLERANCE * frameInterval / speed + DURATION_SLACK_S;
  const expectedVideo = Math.min(input.videoDuration / speed, cap);
  if (Math.abs(output.videoDuration - expectedVideo) > videoTolerance) {
    errors.push(
      `video duration ${output.videoDuration.toFixed(3)}s does not match expected`
      + ` ${expectedVideo.toFixed(3)}s (source ${input.videoDuration.toFixed(3)}s at ${speed}x)`,
    );
  }
  if (input.hasAudio) {
    if (!output.hasAudio || output.audioDuration === null) {
      errors.push("output lost the source audio track");
    } else {
      const expectedAudio = Math.min((input.audioDuration ?? input.videoDuration) / speed, cap);
      if (Math.abs(output.audioDuration - expectedAudio) > AUDIO_TOLERANCE_S) {
        errors.push(
          `audio duration ${output.audioDuration.toFixed(3)}s does not match expected`
          + ` ${expectedAudio.toFixed(3)}s (source audio retimed at ${speed}x)`,
        );
      }
    }
  }
  return errors;
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
      const inputProbe = await probeVideo(inputPath);
      const sourceFrameCount = await probeVideoFrameCount(inputPath);

      const outputFrameRate = sourceFrameCount !== null && inputProbe.videoDuration > 0
        && await hasConstantFrameSpacing(inputPath)
        ? sourceFrameCount / (targetDuration ?? inputProbe.videoDuration / speed)
        : undefined;
      const outputOptions = buildSpeedOutputOptions(speed, hasAudio, targetDuration, outputFrameRate);
      const FFmpeggy = await getFFmpeggy();
      const ff = new FFmpeggy({
        input: inputPath,
        output: outputPath,
        outputOptions,
        overwriteExisting: true,
      });

      await ff.run();
      await ff.done();

      // Validate before touching canonical media: a retime that dropped
      // frames, drifted from the expected duration, or lost the audio track
      // must fail the job and leave the current version recoverable.
      const outputProbe = await probeVideo(outputPath);
      const errors = retimeValidationErrors(inputProbe, outputProbe, speed, targetDuration);
      const outputFrameCount = await probeVideoFrameCount(outputPath);
      if (
        sourceFrameCount !== null
        && outputFrameCount !== null
        && sourceFrameCount !== outputFrameCount
      ) {
        errors.push(
          `video frame count ${outputFrameCount} does not match source ${sourceFrameCount}`,
        );
      }
      if (errors.length > 0) {
        await rm(outputPath, { force: true });
        throw new Error(
          `change_video_speed produced invalid output for ${assetId}: ${errors.join("; ")}`,
        );
      }

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
