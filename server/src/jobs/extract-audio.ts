import type { ClipfirstFs } from "clipfirst-fs";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { registerJobHandler } from "../queue.js";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

const LOCK_DURATION_MS = 120_000;

async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync(FFMPEG, args);
  } catch (error) {
    const msg = error instanceof Error ? (error as Error & { stderr?: string }).stderr ?? error.message : String(error);
    throw new Error(`ffmpeg failed: ${msg}`);
  }
}

type ExtractAudioPayload = {
  type: "extract_audio";
  inputPath: string;
  outputPath: string;
  audioAssetId: string;
  audioAssetDir: string;
  sourceVideoId: string;
  projectSlug: string;
};

export function registerExtractAudioJob(fs: ClipfirstFs): void {
  registerJobHandler("extract_audio", async (payload) => {
    const {
      inputPath, outputPath,
      audioAssetId, audioAssetDir, sourceVideoId, projectSlug,
    } = payload as ExtractAudioPayload;

    const lockResult = await fs.acquireLock(audioAssetDir, { durationMs: LOCK_DURATION_MS });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    try {
      await runFfmpeg([
        "-y",
        "-i", inputPath,
        "-vn",
        "-acodec", "libmp3lame",
        "-q:a", "2",
        outputPath,
      ]);

      const origin = {
        origin: "extract_audio",
        source_asset: sourceVideoId,
      };
      await fsWriteFile(join(audioAssetDir, ".origin.json"), JSON.stringify(origin, null, 2));

      await fs.commitOperation("extract_audio", audioAssetId, { source: sourceVideoId }, projectSlug);

      return { success: true };
    } finally {
      await fs.releaseLock(audioAssetDir);
    }
  });
}
