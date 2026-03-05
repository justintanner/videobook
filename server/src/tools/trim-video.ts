import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z } from "zod";
import { unlink, rename, mkdir, writeFile as fsWriteFile, rm } from "node:fs/promises";
import { join, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { queue, registerJobHandler } from "../queue.js";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "avi", "mkv"]);
const H264_MEDIUM = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-level:v", "4.0"];
const AUDIO_OPTS = ["-c:a", "aac", "-b:a", "192k"];
const CROSSFADE_SECS = 0.03;
const LOCK_DURATION_MS = 300_000;

function findVideoFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const videos = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
  });
  return videos.find((f) => f.name.startsWith("original")) ?? videos[0] ?? null;
}

type ValidatedParams =
  | { mode: "keep"; trimStart: number | undefined; trimEnd: number | undefined }
  | { mode: "cut"; cutStart: number; cutEnd: number }
  | { error: string };

function validateTrimParams(
  trimStart: number | undefined,
  trimEnd: number | undefined,
  cutStart: number | undefined,
  cutEnd: number | undefined,
): ValidatedParams {
  const hasKeep = trimStart !== undefined || trimEnd !== undefined;
  const hasCut = cutStart !== undefined || cutEnd !== undefined;

  if (hasKeep && hasCut) {
    return { error: "Cannot specify both trim (keep) and cut (remove) parameters. Use one mode at a time." };
  }
  if (!hasKeep && !hasCut) {
    return { error: "Must specify trim_start/trim_end (keep range) or cut_start/cut_end (remove range)." };
  }

  if (hasCut) {
    if (cutStart === undefined || cutEnd === undefined) {
      return { error: "Both cut_start and cut_end are required for cut mode." };
    }
    if (cutStart >= cutEnd) {
      return { error: "cut_start must be less than cut_end." };
    }
    if (cutStart < 0 || cutEnd < 0) {
      return { error: "cut_start and cut_end must be >= 0." };
    }
    return { mode: "cut", cutStart, cutEnd };
  }

  if (trimStart !== undefined && trimStart < 0) {
    return { error: "trim_start must be >= 0." };
  }
  if (trimEnd !== undefined && trimEnd < 0) {
    return { error: "trim_end must be >= 0." };
  }
  if (trimStart !== undefined && trimEnd !== undefined && trimStart >= trimEnd) {
    return { error: "trim_start must be less than trim_end." };
  }
  return { mode: "keep", trimStart, trimEnd };
}

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

  if (start !== undefined) {
    args.push("-ss", String(start));
  }

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

export function registerTrimVideoTool(server: McpServer, fs: ClipfirstFs): void {
  registerJobHandler("trim_video", async (payload) => {
    const { inputPath, outputPath, mode, trimStart, trimEnd, cutStart, cutEnd } =
      payload as {
        inputPath: string;
        outputPath: string;
        mode: string;
        trimStart?: number;
        trimEnd?: number;
        cutStart?: number;
        cutEnd?: number;
      };

    if (mode === "cut") {
      await cutMiddle(inputPath, outputPath, cutStart!, cutEnd!);
    } else {
      await trimRange(inputPath, outputPath, trimStart, trimEnd);
    }
    return { success: true };
  });

  server.tool(
    "trim_video",
    "Trim a video asset: keep a time range (trim_start/trim_end) or cut out a middle section (cut_start/cut_end). Operates in-place with git versioning.",
    {
      asset_id: z.string().describe("Asset ID (e.g. vid-my-video)"),
      project_slug: z.string().describe("Project slug"),
      trim_start: z.number().optional().describe("Start of range to keep (seconds)"),
      trim_end: z.number().optional().describe("End of range to keep (seconds)"),
      cut_start: z.number().optional().describe("Start of chunk to remove (seconds)"),
      cut_end: z.number().optional().describe("End of chunk to remove (seconds)"),
    },
    async ({ asset_id, project_slug, trim_start, trim_end, cut_start, cut_end }) => {
      const validated = validateTrimParams(trim_start, trim_end, cut_start, cut_end);
      if ("error" in validated) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: validated.error }],
        };
      }

      const manifestResult = await fs.getManifest(asset_id, project_slug);
      if (!manifestResult.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const manifest = manifestResult.value;
      const videoFile = findVideoFile(manifest.files);
      if (!videoFile) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `No video file found in asset ${asset_id}` }],
        };
      }

      const assetDir = manifest.path;
      const lockResult = await fs.acquireLock(assetDir, { durationMs: LOCK_DURATION_MS });
      if (!lockResult.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Asset is locked: ${lockResult.error.message}` }],
        };
      }

      try {
        const videoPath = join(assetDir, videoFile.name);
        const tempPath = join(assetDir, "original_trimmed.mp4");
        const jobId = `trim-${asset_id}-${Date.now()}`;

        const jobPayload: Record<string, unknown> = {
          type: "trim_video",
          inputPath: videoPath,
          outputPath: tempPath,
          mode: validated.mode,
        };
        if (validated.mode === "keep") {
          jobPayload.trimStart = validated.trimStart;
          jobPayload.trimEnd = validated.trimEnd;
        } else {
          jobPayload.cutStart = validated.cutStart;
          jobPayload.cutEnd = validated.cutEnd;
        }

        await queue.enqueueAndWait(jobId, jobPayload);

        await unlink(videoPath);
        await rename(tempPath, videoPath);

        await fs.commitOperation("trim", asset_id, {
          trim_start,
          trim_end,
          cut_start,
          cut_end,
          mode: validated.mode,
        }, project_slug);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              asset_id,
              mode: validated.mode,
              trim_start,
              trim_end,
              cut_start,
              cut_end,
            }),
          }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Trim failed: ${msg}` }],
        };
      } finally {
        await fs.releaseLock(assetDir);
      }
    },
  );
}
