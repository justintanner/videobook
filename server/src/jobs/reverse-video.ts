import type { ClipfirstFs } from "clipfirst-fs";
import { basename, join } from "node:path";
import { registerJobHandler, queue } from "../queue.js";
import { getFFmpeggy, H264_MEDIUM, AUDIO_OPTS } from "../ffmpeg.js";
import { WHITELISTED_AT_FILE } from "../tools/whitelist-asset.js";

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

export function registerReverseVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("reverse_video", async (payload) => {
    const {
      inputPath, outputPath, hasAudio,
      assetId, assetDir, projectSlug,
    } = payload as ReverseVideoPayload;

    const lockResult = await fs.acquireLock(assetDir, { durationMs: LOCK_DURATION_MS });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    try {
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

      // Re-arm whitelist so transcription pipeline picks up the changed video
      await fs.writeFile(assetId, WHITELISTED_AT_FILE, String(Date.now() / 1000), projectSlug);

      const videoPath = join(assetDir, inputFilename);
      await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
        type: "process_video",
        videoPath, assetId, assetDir, projectSlug,
        provenance: { origin: "reverse", reversed_at: new Date().toISOString() },
        force: true,
        skipDownstreamJobs: true,
      } as unknown as Record<string, unknown>);

      return { success: true };
    } finally {
      await fs.releaseLock(assetDir);
    }
  });
}
