import type { VideocityFs } from "vc-engine";
import { execFile } from "node:child_process";
import { mkdir, writeFile as fsWriteFile, rename, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join, basename } from "node:path";
import { registerJobHandler, queue } from "../queue.js";
import { runFfmpeg, H264_MEDIUM, AUDIO_OPTS, FFPROBE } from "../ffmpeg.js";
import { withLockedLocalLease } from "./_lease.js";

const execFileAsync = promisify(execFile);

const LOCK_DURATION_MS = 300_000;
const CROSSFADE_SECS = 0.03;
const DURATION_EPSILON_SECS = 0.5;
const AV_DRIFT_TOLERANCE_SECS = 0.5;
// `ffmpeg -t N` lands on the next frame/sample boundary, so the container's
// reported format duration is typically 10–50ms longer than N. Pre-shrink by
// one slack window so the output stays ≤ the requested length — required for
// downstream caps like Wan 2.7's 10s VideoEdit limit.
const TRIM_DURATION_SAFETY_SECS = 0.05;

interface StreamDurations {
  format: number;
  video: number;
  audio: number | null;
}

export async function probeStreamDurations(filePath: string): Promise<StreamDurations> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    filePath,
  ]);
  const data = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; duration?: string }>;
    format?: { duration?: string };
  };
  const format = Number(data.format?.duration ?? 0);
  const videoStream = data.streams?.find((s) => s.codec_type === "video");
  const audioStream = data.streams?.find((s) => s.codec_type === "audio");
  const video = Number(videoStream?.duration ?? format);
  const audio = audioStream ? Number(audioStream.duration ?? format) : null;
  return { format, video, audio };
}

export async function assertSaneTrimOutput(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const [input, output] = await Promise.all([
    probeStreamDurations(inputPath),
    probeStreamDurations(outputPath),
  ]);
  if (output.format <= 0 || output.video <= 0) {
    throw new Error(
      `Trim output has zero duration (format=${output.format}, video=${output.video})`,
    );
  }
  if (output.format > input.format + DURATION_EPSILON_SECS) {
    throw new Error(
      `Trim output duration ${output.format.toFixed(3)}s exceeds input ${input.format.toFixed(3)}s — likely a corrupted concat`,
    );
  }
  if (output.audio !== null && Math.abs(output.video - output.audio) > AV_DRIFT_TOLERANCE_SECS) {
    throw new Error(
      `Trim output audio/video duration mismatch: video=${output.video.toFixed(3)}s audio=${output.audio.toFixed(3)}s`,
    );
  }
}

// Write to `${outputPath}.tmp` then rename to outputPath, so a partial write
// (process killed mid-encode, OOM, etc.) never leaves a moov-less file
// sitting at the canonical asset path. `+faststart` puts moov at the front,
// which means even a truncated mp4 is partially playable AND surfaces obvious
// corruption to the user immediately rather than after first probe.
export async function trimRange(
  inputPath: string,
  outputPath: string,
  start: number | undefined,
  end: number | undefined,
): Promise<void> {
  const args = ["-y"];
  if (start !== undefined) args.push("-ss", String(start));
  args.push("-i", inputPath);
  if (end !== undefined) {
    const requested = start !== undefined ? end - start : end;
    const safe = Math.max(0.01, requested - TRIM_DURATION_SAFETY_SECS);
    args.push("-t", String(safe));
  }
  const tmpPath = `${outputPath}.tmp`;
  args.push(...H264_MEDIUM, ...AUDIO_OPTS, "-movflags", "+faststart", "-f", "mp4", tmpPath);
  try {
    await runFfmpeg(args);
    await rename(tmpPath, outputPath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Cut exactly `durationSec` seconds starting at `startSec`, with the output's
 * container duration reported as the integer second value (not 9.97 / 10.01).
 *
 * The trick: forcing the output framerate to 24 means a 23.976-fps source
 * (very common — YouTube, most films) becomes 240 frames at 24fps = 10.000s.
 * Audio gets `-t durationSec` directly. With both streams landing on
 * the same integer-second boundary, ffprobe reports `format=duration` as
 * an integer.
 *
 * Used by /even-split where the user wants the first chunk to read as
 * "exactly 10s" / "exactly 9s" — a hard requirement for some video-gen UIs
 * that match on the duration field. No safety margin: precision is the goal.
 */
export async function trimRangeExact(
  inputPath: string,
  outputPath: string,
  startSec: number,
  durationSec: number,
): Promise<void> {
  const args = ["-y"];
  if (startSec > 0) args.push("-ss", String(startSec));
  args.push("-i", inputPath);
  args.push("-t", String(durationSec));
  args.push("-r", "24", "-vsync", "cfr");
  const tmpPath = `${outputPath}.tmp`;
  args.push(...H264_MEDIUM, ...AUDIO_OPTS, "-movflags", "+faststart", "-f", "mp4", tmpPath);
  try {
    await runFfmpeg(args);
    await rename(tmpPath, outputPath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

async function cutMiddle(
  inputPath: string,
  outputPath: string,
  cutStart: number,
  cutEnd: number,
): Promise<void> {
  // Degenerate cuts: if the cut starts at 0 or ends at/past input duration,
  // one of the two halves would be empty (`-t 0` or seek-past-end) and the
  // subsequent concat fails with "Output file does not contain any stream".
  // Delegate to a single trimRange call in those cases.
  if (cutStart <= 0) {
    await trimRange(inputPath, outputPath, cutEnd, undefined);
    return;
  }
  const { format: inputDuration } = await probeStreamDurations(inputPath);
  if (cutEnd >= inputDuration - DURATION_EPSILON_SECS) {
    await trimRange(inputPath, outputPath, undefined, cutStart);
    return;
  }

  const tempDir = join(outputPath, "..", ".trim_temp");
  await mkdir(tempDir, { recursive: true });

  try {
    const beforePath = join(tempDir, "before.mp4");
    const afterPath = join(tempDir, "after.mp4");
    const concatList = join(tempDir, "concat.txt");

    // The before/after halves read disjoint ranges of the input and write to
    // different output files, so run them in parallel. Halves cut-middle
    // wall-clock on multi-core hosts.
    const fadeOutStart = Math.max(cutStart - CROSSFADE_SECS, 0);
    await Promise.all([
      runFfmpeg([
        "-y", "-i", inputPath,
        "-t", String(cutStart),
        "-af", `afade=t=out:st=${fadeOutStart}:d=${CROSSFADE_SECS}`,
        ...H264_MEDIUM, ...AUDIO_OPTS,
        beforePath,
      ]),
      runFfmpeg([
        "-y", "-ss", String(cutEnd),
        "-i", inputPath,
        "-af", `afade=t=in:d=${CROSSFADE_SECS}`,
        ...H264_MEDIUM, ...AUDIO_OPTS,
        afterPath,
      ]),
    ]);

    await fsWriteFile(concatList, `file '${beforePath}'\nfile '${afterPath}'\n`);

    // Re-encode rather than `-c copy`: the two halves are independently-encoded
    // libx264/AAC streams, so their SPS/PPS, GOP boundaries, and AAC priming
    // samples don't line up — a copy-concat produces a container with bogus
    // duration metadata and a truncated audio stream.
    await runFfmpeg([
      "-y", "-f", "concat", "-safe", "0",
      "-i", concatList,
      ...H264_MEDIUM, ...AUDIO_OPTS,
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

export function registerTrimVideoJob(fs: VideocityFs): void {
  registerJobHandler("trim_video", async (payload, ctx) => {
    const {
      inputPath, outputPath, mode, trimStart, trimEnd, cutStart, cutEnd,
      assetId, assetDir, projectSlug,
    } = payload as TrimVideoPayload;

    const result = await withLockedLocalLease(
      fs,
      projectSlug,
      assetId,
      assetDir,
      ctx,
      "trim",
      { durationMs: LOCK_DURATION_MS, data: { state: "trimming" } },
      async () => {
      if (mode === "cut") {
        await cutMiddle(inputPath, outputPath, cutStart!, cutEnd!);
      } else {
        await trimRange(inputPath, outputPath, trimStart, trimEnd);
      }

      try {
        await assertSaneTrimOutput(inputPath, outputPath);
      } catch (err) {
        await rm(outputPath, { force: true });
        throw err;
      }

      const inputFilename = basename(inputPath);
      const outputFilename = basename(outputPath);
      await fs.deleteFile(assetId, inputFilename, projectSlug);
      await fs.renameFile(assetId, outputFilename, inputFilename, projectSlug);

      for (const stale of [
        ".original.analysis.json",
        ".analysis.gpt4otrans.json",
        "elevenlabs.json",
        ".kie-task.json",
      ]) {
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
        provenance: { origin: "trim", trimmed_at: new Date().toISOString() },
        force: true,
      } as unknown as Record<string, unknown>);

      return { success: true };
  });
}
