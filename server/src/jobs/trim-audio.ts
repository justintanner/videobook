import type { VideocityFs } from "videocity-engine";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, basename, extname } from "node:path";
import { rm } from "node:fs/promises";
import { registerJobHandler, queue } from "../queue.js";
import { FFMPEG, FFPROBE } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";

const execFileAsync = promisify(execFile);
const LOCK_DURATION_MS = 300_000;

async function probeAudioDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  const data = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; duration?: string }>;
    format?: { duration?: string };
  };
  const audioStream = data.streams?.find((s) => s.codec_type === "audio");
  const formatDuration = Number(data.format?.duration ?? 0);
  const streamDuration = audioStream ? Number(audioStream.duration ?? formatDuration) : formatDuration;
  return Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : formatDuration;
}

function buildTrimAudioArgs(
  inputPath: string,
  outputPath: string,
  mode: "keep" | "cut",
  trimStart?: number,
  trimEnd?: number,
  cutStart?: number,
  cutEnd?: number,
): string[] {
  const ext = extname(inputPath).toLowerCase();
  const codecArgs = ext === ".mp3"
    ? ["-c:a", "libmp3lame", "-q:a", "2"]
    : ext === ".ogg"
    ? ["-c:a", "libvorbis", "-q:a", "4"]
    : ext === ".flac"
    ? ["-c:a", "flac"]
    : ext === ".wav"
    ? ["-c:a", "pcm_s16le"]
    : ["-c:a", "aac", "-b:a", "192k"];

  if (mode === "keep") {
    const args: string[] = [];
    if (trimStart !== undefined && trimStart > 0) {
      args.push("-ss", String(trimStart));
    }
    args.push("-i", inputPath);
    if (trimStart !== undefined && trimStart > 0 && trimEnd !== undefined) {
      const duration = Math.max(0, trimEnd - trimStart);
      args.push("-t", String(duration));
    } else if (trimEnd !== undefined) {
      args.push("-to", String(trimEnd));
    }
    args.push(...codecArgs, "-y", outputPath);
    return args;
  } else {
    const cStart = cutStart ?? 0;
    if (cStart <= 0) {
      return buildTrimAudioArgs(inputPath, outputPath, "keep", cutEnd, undefined);
    }
    const filter = `[0:a]atrim=0:${cStart}[a1];[0:a]atrim=start=${cutEnd}[a2];[a1][a2]concat=n=2:v=0:a=1[a]`;
    return [
      "-i", inputPath,
      "-filter_complex", filter,
      "-map", "[a]",
      ...codecArgs,
      "-y", outputPath,
    ];
  }
}

async function runTrimAudio(
  inputPath: string,
  outputPath: string,
  mode: "keep" | "cut",
  trimStart?: number,
  trimEnd?: number,
  cutStart?: number,
  cutEnd?: number,
): Promise<void> {
  const args = buildTrimAudioArgs(inputPath, outputPath, mode, trimStart, trimEnd, cutStart, cutEnd);
  await execFileAsync(FFMPEG, args);

  const duration = await probeAudioDuration(outputPath);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Trimmed audio output is invalid or has 0 duration (duration=${duration})`);
  }
}

export type TrimAudioPayload = {
  type: "trim_audio";
  inputPath: string;
  outputPath: string;
  mode: "keep" | "cut";
  trimStart?: number;
  trimEnd?: number;
  cutStart?: number;
  cutEnd?: number;
  assetId: string;
  assetDir: string;
  projectSlug: string;
  isVideo?: boolean;
  commitParams: Record<string, unknown>;
};

export function registerTrimAudioJob(fs: VideocityFs): void {
  registerJobHandler("trim_audio", async (payload, ctx) => {
    const {
      inputPath, outputPath, mode, trimStart, trimEnd, cutStart, cutEnd,
      assetId, assetDir, projectSlug, isVideo = false, commitParams,
    } = payload as TrimAudioPayload;

    try {
      const result = await withLockedLocalLease(
        fs,
        projectSlug,
        assetId,
        assetDir,
        ctx,
        "trim",
        { durationMs: LOCK_DURATION_MS, data: { state: "trimming-audio", ...commitParams } },
        async () => {
          await runTrimAudio(inputPath, outputPath, mode, trimStart, trimEnd, cutStart, cutEnd);

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
          provenance: { origin: "trim_audio", ...commitParams, trimmed_at: new Date().toISOString() },
          force: true,
          skipDownstreamJobs: true,
        } as unknown as Record<string, unknown>);
      }

      return { success: true };
    } finally {
      await rm(outputPath, { force: true }).catch(() => {});
    }
  });
}
