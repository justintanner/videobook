import type { VideocityFs } from "vc-engine";
import { basename, extname, join } from "node:path";
import { registerJobHandler, queue } from "../queue.js";
import { getFFmpeggy, AUDIO_OPTS } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 300_000;

function buildBoostOutputOptions(boost: number, isVideo: boolean, inputPath: string): string[] {
  const audioFilter = `volume=${boost}`;
  if (isVideo) {
    return ["-c:v", "copy", "-af", audioFilter, ...AUDIO_OPTS];
  }
  const ext = extname(inputPath).toLowerCase();
  if (ext === ".mp3") {
    return ["-af", audioFilter, "-c:a", "libmp3lame", "-q:a", "2"];
  }
  return ["-af", audioFilter, ...AUDIO_OPTS];
}

type AudioBoostPayload = {
  type: "audio_boost";
  inputPath: string;
  outputPath: string;
  boost: number;
  isVideo: boolean;
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

export function registerAudioBoostJob(fs: VideocityFs): void {
  registerJobHandler("audio_boost", async (payload, ctx) => {
    const {
      inputPath, outputPath, boost, isVideo,
      assetId, assetDir, projectSlug,
    } = payload as AudioBoostPayload;

    const result = await withLockedLocalLease(
      fs,
      projectSlug,
      assetId,
      assetDir,
      ctx,
      "apply_sfx",
      { durationMs: LOCK_DURATION_MS, data: { state: "boosting-audio" } },
      async () => {
        const outputOptions = buildBoostOutputOptions(boost, isVideo, inputPath);
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

        const mediaPath = join(assetDir, inputFilename);
        return { mediaPath };
      },
      { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
    );

    if (isVideo) {
      await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
        type: "process_video",
        videoPath: result.mediaPath,
        assetId,
        assetDir,
        projectSlug,
        provenance: { origin: "audio_boost", boost, boosted_at: new Date().toISOString() },
        force: true,
        skipDownstreamJobs: true,
      } as unknown as Record<string, unknown>);
    }

    return { success: true };
  });
}
