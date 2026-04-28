import type { ClipfirstFs } from "clipfirst-fs";
import { join, basename } from "node:path";
import { registerJobHandler, queue } from "../queue.js";
import { runFfmpeg } from "../ffmpeg.js";
import { WHITELISTED_AT_FILE } from "../tools/whitelist-asset.js";

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
};

export function registerReplaceVideoAudioJob(fs: ClipfirstFs): void {
  registerJobHandler("replace_video_audio", async (payload) => {
    const {
      inputPath, audioPath, outputPath,
      assetId, assetDir, audioAssetId, projectSlug,
    } = payload as ReplaceVideoAudioPayload;

    const lockResult = await fs.acquireLock(assetDir, { durationMs: LOCK_DURATION_MS, data: { state: "generating" } });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    try {
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

      await fs.writeFile(assetId, WHITELISTED_AT_FILE, String(Date.now() / 1000), projectSlug);

      for (const stale of STALE_ANALYSIS_FILES) {
        await fs.deleteFile(assetId, stale, projectSlug);
      }

      const videoPath = join(assetDir, inputFilename);
      await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
        type: "process_video",
        videoPath, assetId, assetDir, projectSlug,
        provenance: {
          origin: "replace_audio",
          source_audio: audioAssetId,
          replaced_at: new Date().toISOString(),
        },
        force: true,
      } as unknown as Record<string, unknown>);

      return { success: true };
    } finally {
      await fs.releaseLock(assetDir);
    }
  });
}
