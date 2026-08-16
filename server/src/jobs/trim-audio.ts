import type { Engine } from "videobook-engine";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, extname } from "node:path";
import { registerJobHandler } from "../queue.js";
import { FFMPEG, FFPROBE } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";
import { replaceArtifactFileFromPath } from "./_persist-output.js";

const execFileAsync = promisify(execFile);
const LOCK_DURATION_MS = 300_000;
const DURATION_EPSILON_SECONDS = 0.05;

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
  const audioStream = data.streams?.find((stream) => stream.codec_type === "audio");
  if (!audioStream) throw new Error("Audio file has no usable audio stream");
  const formatDuration = Number(data.format?.duration ?? 0);
  const streamDuration = Number(audioStream.duration ?? formatDuration);
  const duration = Number.isFinite(streamDuration) && streamDuration > 0
    ? streamDuration
    : formatDuration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Audio file has invalid duration (${duration})`);
  }
  return duration;
}

function audioCodecArgs(inputPath: string): string[] {
  const ext = extname(inputPath).toLowerCase();
  if (ext === ".mp3") return ["-c:a", "libmp3lame", "-q:a", "2"];
  if (ext === ".ogg") return ["-c:a", "libvorbis", "-q:a", "4"];
  if (ext === ".flac") return ["-c:a", "flac"];
  if (ext === ".wav") return ["-c:a", "pcm_s16le"];
  return ["-c:a", "aac", "-b:a", "192k"];
}

function expectedOutputDuration(
  sourceDuration: number,
  mode: "keep" | "cut",
  trimStart?: number,
  trimEnd?: number,
  cutStart?: number,
  cutEnd?: number,
): number {
  if (mode === "keep") {
    const start = trimStart ?? 0;
    const end = trimEnd ?? sourceDuration;
    if (start >= sourceDuration - DURATION_EPSILON_SECONDS) {
      throw new Error(`trim_start ${start} must be before audio duration ${sourceDuration.toFixed(3)}`);
    }
    if (end > sourceDuration + DURATION_EPSILON_SECONDS) {
      throw new Error(`trim_end ${end} exceeds audio duration ${sourceDuration.toFixed(3)}`);
    }
    return Math.min(end, sourceDuration) - start;
  }

  const start = cutStart ?? 0;
  const end = cutEnd ?? sourceDuration;
  if (start >= sourceDuration - DURATION_EPSILON_SECONDS) {
    throw new Error(`cut_start ${start} must be before audio duration ${sourceDuration.toFixed(3)}`);
  }
  if (end > sourceDuration + DURATION_EPSILON_SECONDS) {
    throw new Error(`cut_end ${end} exceeds audio duration ${sourceDuration.toFixed(3)}`);
  }
  return sourceDuration - (Math.min(end, sourceDuration) - start);
}

function buildKeepArgs(
  inputPath: string,
  outputPath: string,
  start: number,
  duration: number,
): string[] {
  const args: string[] = [];
  if (start > 0) args.push("-ss", String(start));
  args.push(
    "-i", inputPath,
    "-map", "0:a:0",
    "-vn",
    "-t", String(duration),
    ...audioCodecArgs(inputPath),
    "-y", outputPath,
  );
  return args;
}

function buildTrimAudioArgs(
  inputPath: string,
  outputPath: string,
  sourceDuration: number,
  mode: "keep" | "cut",
  trimStart?: number,
  trimEnd?: number,
  cutStart?: number,
  cutEnd?: number,
): { args: string[]; expectedDuration: number } {
  const expectedDuration = expectedOutputDuration(
    sourceDuration,
    mode,
    trimStart,
    trimEnd,
    cutStart,
    cutEnd,
  );
  if (expectedDuration <= DURATION_EPSILON_SECONDS) {
    throw new Error("Trim would produce an empty audio file");
  }

  if (mode === "keep") {
    return {
      args: buildKeepArgs(inputPath, outputPath, trimStart ?? 0, expectedDuration),
      expectedDuration,
    };
  }

  const start = cutStart ?? 0;
  const end = Math.min(cutEnd ?? sourceDuration, sourceDuration);
  if (start <= DURATION_EPSILON_SECONDS) {
    return {
      args: buildKeepArgs(inputPath, outputPath, end, expectedDuration),
      expectedDuration,
    };
  }
  if (end >= sourceDuration - DURATION_EPSILON_SECONDS) {
    return {
      args: buildKeepArgs(inputPath, outputPath, 0, expectedDuration),
      expectedDuration,
    };
  }

  const filter = [
    `[0:a]atrim=0:${start},asetpts=PTS-STARTPTS[a1]`,
    `[0:a]atrim=start=${end},asetpts=PTS-STARTPTS[a2]`,
    "[a1][a2]concat=n=2:v=0:a=1[a]",
  ].join(";");
  return {
    args: [
      "-i", inputPath,
      "-filter_complex", filter,
      "-map", "[a]",
      ...audioCodecArgs(inputPath),
      "-y", outputPath,
    ],
    expectedDuration,
  };
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
  const sourceDuration = await probeAudioDuration(inputPath);
  const { args, expectedDuration } = buildTrimAudioArgs(
    inputPath,
    outputPath,
    sourceDuration,
    mode,
    trimStart,
    trimEnd,
    cutStart,
    cutEnd,
  );
  await execFileAsync(FFMPEG, args);

  const outputDuration = await probeAudioDuration(outputPath);
  const tolerance = Math.max(0.35, expectedDuration * 0.05);
  if (Math.abs(outputDuration - expectedDuration) > tolerance) {
    throw new Error(
      `Trimmed audio duration ${outputDuration.toFixed(3)} did not match expected ${expectedDuration.toFixed(3)}`,
    );
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
  bookId: string;
  commitParams: Record<string, unknown>;
};

export function registerTrimAudioJob(fs: Engine): void {
  registerJobHandler("trim_audio", async (payload, ctx) => {
    const {
      inputPath, outputPath, mode, trimStart, trimEnd, cutStart, cutEnd,
      assetId, assetDir, commitParams,
    } = payload as TrimAudioPayload;
    const inputFilename = basename(inputPath);

    try {
      await withLockedLocalLease(
        fs,
        assetId,
        assetDir,
        ctx,
        "trim",
        { durationMs: LOCK_DURATION_MS, data: { state: "trimming-audio", ...commitParams } },
        async () => {
          const original = await fs.files.read(assetId, inputFilename);
          if (!original.ok) throw new Error(original.error.message);
          await runTrimAudio(inputPath, outputPath, mode, trimStart, trimEnd, cutStart, cutEnd);
          await replaceArtifactFileFromPath(
            fs,
            assetId,
            inputFilename,
            outputPath,
          );
          const provenanceResult = await fs.metadata.artifacts.write(assetId, "original", {
            origin: "trim_audio",
            source_asset_id: assetId,
            ...commitParams,
            trimmed_at: new Date().toISOString(),
          });
          if (!provenanceResult.ok) {
            const rollback = await fs.files.write(assetId, inputFilename, original.value
            );
            if (!rollback.ok) {
              throw new Error(
                `${provenanceResult.error.message}; rollback failed: ${rollback.error.message}`,
              );
            }
            throw new Error(provenanceResult.error.message);
          }
        },
        { durationMs: LOCK_DURATION_MS, waitForActiveMs: 30_000 },
      );
      return { success: true };
    } finally {
      await rm(outputPath, { force: true });
    }
  });
}
