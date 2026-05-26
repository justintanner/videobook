import type { VideocityFs } from "vc-engine";
import { basename, join } from "node:path";
import { registerJobHandler, queue } from "../queue.js";
import { getFFmpeggy, H264_MEDIUM, AUDIO_OPTS } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 300_000;

function buildReverseOutputOptions(hasAudio: boolean): string[] {
  const opts = ["-vf", "reverse"];
  if (hasAudio) {
    opts.push("-af", "areverse");
  } else {
    opts.push("-an");
  }
  opts.push(...H264_MEDIUM, ...AUDIO_OPTS);
  return opts;
}

type ReverseVideoPayload = {
  type: "reverse_video";
  inputPath: string;
  outputPath: string;
  hasAudio: boolean;
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

export function registerReverseVideoJob(fs: VideocityFs): void {
  registerJobHandler("reverse_video", async (payload, ctx) => {
    const {
      inputPath, outputPath, hasAudio,
      assetId, assetDir, projectSlug,
    } = payload as ReverseVideoPayload;

    const result = await withLockedLocalLease(
      fs,
      projectSlug,
      assetId,
      assetDir,
      ctx,
      "reverse",
      { durationMs: LOCK_DURATION_MS, data: { state: "reversing" } },
      async () => {
      const outputOptions = buildReverseOutputOptions(hasAudio);
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
      return { videoPath };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
      type: "process_video",
      videoPath: result.videoPath,
      assetId,
      assetDir,
      projectSlug,
      provenance: { origin: "reverse", reversed_at: new Date().toISOString() },
      force: true,
      skipDownstreamJobs: true,
    } as unknown as Record<string, unknown>);

    return { success: true };
  });
}
