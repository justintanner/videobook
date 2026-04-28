import type { ClipfirstFs } from "clipfirst-fs";
import { mkdir, writeFile as fsWriteFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { registerJobHandler, queue } from "../queue.js";
import { runFfmpeg, H264_MEDIUM, AUDIO_OPTS } from "../ffmpeg.js";

const LOCK_DURATION_MS = 300_000;
const CROSSFADE_SECS = 0.03;

async function trimRange(
  inputPath: string,
  outputPath: string,
  start: number | undefined,
  end: number | undefined,
): Promise<void> {
  const args = ["-y"];
  if (start !== undefined) args.push("-ss", String(start));
  args.push("-i", inputPath);
  if (end !== undefined) {
    const duration = start !== undefined ? end - start : end;
    args.push("-t", String(duration));
  }
  args.push(...H264_MEDIUM, ...AUDIO_OPTS, outputPath);
  await runFfmpeg(args);
}

async function cutMiddle(
  inputPath: string,
  outputPath: string,
  cutStart: number,
  cutEnd: number,
): Promise<void> {
  const tempDir = join(outputPath, "..", ".trim_temp");
  await mkdir(tempDir, { recursive: true });

  try {
    const beforePath = join(tempDir, "before.mp4");
    const afterPath = join(tempDir, "after.mp4");
    const concatList = join(tempDir, "concat.txt");

    const fadeOutStart = Math.max(cutStart - CROSSFADE_SECS, 0);
    await runFfmpeg([
      "-y", "-i", inputPath,
      "-t", String(cutStart),
      "-af", `afade=t=out:st=${fadeOutStart}:d=${CROSSFADE_SECS}`,
      ...H264_MEDIUM, ...AUDIO_OPTS,
      beforePath,
    ]);

    await runFfmpeg([
      "-y", "-ss", String(cutEnd),
      "-i", inputPath,
      "-af", `afade=t=in:d=${CROSSFADE_SECS}`,
      ...H264_MEDIUM, ...AUDIO_OPTS,
      afterPath,
    ]);

    await fsWriteFile(concatList, `file '${beforePath}'\nfile '${afterPath}'\n`);

    await runFfmpeg([
      "-y", "-f", "concat", "-safe", "0",
      "-i", concatList,
      "-c", "copy",
      outputPath,
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

type TrimVideoPayload = {
  type: "trim_video";
  inputPath: string;
  outputPath: string;
  mode: string;
  trimStart?: number;
  trimEnd?: number;
  cutStart?: number;
  cutEnd?: number;
  assetId: string;
  assetDir: string;
  projectSlug: string;
  commitParams: Record<string, unknown>;
};

export function registerTrimVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("trim_video", async (payload) => {
    const {
      inputPath, outputPath, mode, trimStart, trimEnd, cutStart, cutEnd,
      assetId, assetDir, projectSlug,
    } = payload as TrimVideoPayload;

    const lockResult = await fs.acquireLock(assetDir, { durationMs: LOCK_DURATION_MS, data: { state: "trimming" } });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    try {
      if (mode === "cut") {
        await cutMiddle(inputPath, outputPath, cutStart!, cutEnd!);
      } else {
        await trimRange(inputPath, outputPath, trimStart, trimEnd);
      }

      const inputFilename = basename(inputPath);
      const outputFilename = basename(outputPath);
      await fs.deleteFile(assetId, inputFilename, projectSlug);
      await fs.renameFile(assetId, outputFilename, inputFilename, projectSlug);

      // Clear stale analysis from pre-trim content so the full pipeline re-runs
      // against the new trimmed file. NOT_FOUND is expected for files that weren't
      // produced the first time around.
      for (const stale of [
        ".original.analysis.json",
        ".analysis.gpt4otrans.json",
        "elevenlabs.json",
        ".kie-task.json",
      ]) {
        await fs.deleteFile(assetId, stale, projectSlug);
      }

      const videoPath = join(assetDir, inputFilename);
      await queue.enqueue(`process-video-${assetId}-${Date.now()}`, {
        type: "process_video",
        videoPath, assetId, assetDir, projectSlug,
        provenance: { origin: "trim", trimmed_at: new Date().toISOString() },
        force: true,
      } as unknown as Record<string, unknown>);

      return { success: true };
    } finally {
      await fs.releaseLock(assetDir);
    }
  });
}
