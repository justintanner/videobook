import type { ClipfirstFs } from "clipfirst-engine";
import { basename, join } from "node:path";
import { registerJobHandler, queue } from "../queue.js";
import { getFFmpeggy, H264_MEDIUM, AUDIO_OPTS } from "../ffmpeg.js";

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
  hasAudio: boolean;
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

export function registerChangeVideoSpeedJob(fs: ClipfirstFs): void {
  registerJobHandler("change_video_speed", async (payload) => {
    const {
      inputPath, outputPath, speed, hasAudio,
      assetId, assetDir, projectSlug,
    } = payload as ChangeVideoSpeedPayload;

    const lockResult = await fs.acquireLock(assetDir, { durationMs: LOCK_DURATION_MS, data: { state: "changing-speed" } });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    try {
      const outputOptions = buildSpeedOutputOptions(speed, hasAudio);
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
      const outputFilename = basename(outputPath);
      await fs.deleteFile(assetId, inputFilename, projectSlug);
      await fs.renameFile(assetId, outputFilename, inputFilename, projectSlug);

      const videoPath = join(assetDir, inputFilename);
      await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
        type: "process_video",
        videoPath, assetId, assetDir, projectSlug,
        provenance: { origin: "speed_change", speed, speed_changed_at: new Date().toISOString() },
        force: true,
        skipDownstreamJobs: true,
      } as unknown as Record<string, unknown>);

      return { success: true };
    } finally {
      await fs.releaseLock(assetDir);
    }
  });
}
