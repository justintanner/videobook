import type { ClipfirstFs } from "clipfirst-fs";
import { unlink, rename, mkdir, writeFile as fsWriteFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { registerJobHandler } from "../queue.js";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

const LOCK_DURATION_MS = 300_000;
const H264_MEDIUM = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-level:v", "4.0"];
const AUDIO_OPTS = ["-c:a", "aac", "-b:a", "192k"];
const CROSSFADE_SECS = 0.03;

async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync(FFMPEG, args);
  } catch (error) {
    const msg = error instanceof Error ? (error as Error & { stderr?: string }).stderr ?? error.message : String(error);
    throw new Error(`ffmpeg failed: ${msg}`);
  }
}

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
      assetId, assetDir, projectSlug, commitParams,
    } = payload as TrimVideoPayload;

    const lockResult = await fs.acquireLock(assetDir, { durationMs: LOCK_DURATION_MS });
    if (!lockResult.ok) throw new Error(`Asset is locked: ${lockResult.error.message}`);

    try {
      if (mode === "cut") {
        await cutMiddle(inputPath, outputPath, cutStart!, cutEnd!);
      } else {
        await trimRange(inputPath, outputPath, trimStart, trimEnd);
      }

      await unlink(inputPath);
      await rename(outputPath, inputPath);

      await fs.commitOperation("trim", assetId, commitParams, projectSlug);

      return { success: true };
    } finally {
      await fs.releaseLock(assetDir);
    }
  });
}
