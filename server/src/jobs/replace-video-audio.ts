import type { ClipfirstFs } from "vc-engine";
import { join, basename } from "node:path";
import { registerJobHandler, queue } from "../queue.js";
import { runFfmpeg } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";

const LOCK_DURATION_MS = 300_000;

const STALE_ANALYSIS_FILES = [
  ".original.analysis.json",
  ".analysis.gpt4otrans.json",
  "elevenlabs.json",
  ".kie-task.json",
];

type ReplaceVideoAudioPayload = {
  type: "replace_video_audio";
  inputPath: string;
  audioPath: string;
  outputPath: string;
  assetId: string;
  assetDir: string;
  audioAssetId: string;
  projectSlug: string;
  // Merged into the final process_video provenance. Lets a chained caller
  // (e.g. completeSeedance2Video) preserve its own source/model/prompt fields
  // — without this they'd be overwritten by the replace-audio metadata write.
  extraProvenance?: Record<string, unknown>;
};

export function registerReplaceVideoAudioJob(fs: ClipfirstFs): void {
  registerJobHandler("replace_video_audio", async (payload, ctx) => {
    const {
      inputPath, audioPath, outputPath,
      assetId, assetDir, audioAssetId, projectSlug,
      extraProvenance,
    } = payload as ReplaceVideoAudioPayload;

    const result = await withLockedLocalLease(
      fs,
      projectSlug,
      assetId,
      assetDir,
      ctx,
      "replace_audio",
      { durationMs: LOCK_DURATION_MS, data: { state: "replacing-audio" } },
      async () => {
      await runFfmpeg([
        "-y",
        "-i", inputPath,
        "-i", audioPath,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        outputPath,
      ]);

      const inputFilename = basename(inputPath);
      const outputFilename = basename(outputPath);
      await fs.deleteFile(assetId, inputFilename, projectSlug);
      await fs.renameFile(assetId, outputFilename, inputFilename, projectSlug);

      for (const stale of STALE_ANALYSIS_FILES) {
        await fs.deleteFile(assetId, stale, projectSlug);
      }

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
      provenance: {
        ...(extraProvenance ?? {}),
        origin: "replace_audio",
        source_audio: audioAssetId,
        replaced_at: new Date().toISOString(),
      },
      force: true,
    } as unknown as Record<string, unknown>);

    return { success: true };
  });
}
