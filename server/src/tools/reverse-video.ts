import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z } from "zod";
import { unlink, rename } from "node:fs/promises";
import { join, extname } from "node:path";
import { createRequire } from "node:module";
import { queue, registerJobHandler } from "../queue.js";

interface ProbeStream {
  codec_type: string;
}
interface ProbeFormat {
  duration: string;
}
interface ProbeResult {
  streams: ProbeStream[];
  format: ProbeFormat;
}
interface FFmpeggyConstructorOpts {
  input: string;
  output: string;
  outputOptions: string[];
  overwriteExisting: boolean;
}
interface FFmpeggyInstance {
  run(): Promise<unknown>;
  done(): Promise<unknown>;
}
interface FFmpeggyClass {
  new (opts: FFmpeggyConstructorOpts): FFmpeggyInstance;
  DefaultConfig: { ffmpegBin: string; ffprobeBin: string };
  probe(filePath: string): Promise<ProbeResult>;
}

const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");
const FFPROBE: string = require("ffprobe-static").path;

let _FFmpeggy: FFmpeggyClass | null = null;
function getFFmpeggy(): FFmpeggyClass {
  if (!_FFmpeggy) {
    const mod: { FFmpeggy: FFmpeggyClass } = require("ffmpeggy");
    _FFmpeggy = mod.FFmpeggy;
    _FFmpeggy.DefaultConfig.ffmpegBin = FFMPEG;
    _FFmpeggy.DefaultConfig.ffprobeBin = FFPROBE;
  }
  return _FFmpeggy;
}

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "avi", "mkv"]);
const LOCK_DURATION_MS = 300_000;
const MAX_DURATION_SECONDS = 300;
const H264_MEDIUM = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-level:v", "4.0"];
const AUDIO_OPTS = ["-c:a", "aac", "-b:a", "192k"];

function findVideoFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const videos = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
  });
  return videos.find((f) => f.name.startsWith("original")) ?? videos[0] ?? null;
}

function buildReverseOutputOptions(hasAudio: boolean): string[] {
  const opts = ["-vf", "reverse"];

  if (hasAudio) {
    opts.push("-af", "areverse");
  } else {
    opts.push("-an");
  }

  opts.push(...H264_MEDIUM, ...AUDIO_OPTS);
  return opts;
}

async function hasAudioStream(filePath: string): Promise<boolean> {
  const probe = await getFFmpeggy().probe(filePath);
  return probe.streams.some((s) => s.codec_type === "audio");
}

async function getVideoDuration(filePath: string): Promise<number> {
  const probe = await getFFmpeggy().probe(filePath);
  return parseFloat(probe.format.duration);
}

export function registerReverseVideoTool(server: McpServer, fs: ClipfirstFs): void {
  registerJobHandler("reverse_video", async (payload) => {
    const { inputPath, outputPath, hasAudio } = payload as {
      inputPath: string;
      outputPath: string;
      hasAudio: boolean;
    };

    const outputOptions = buildReverseOutputOptions(hasAudio);

    const FFmpeggy = getFFmpeggy();
    const ff = new FFmpeggy({
      input: inputPath,
      output: outputPath,
      outputOptions,
      overwriteExisting: true,
    });

    await ff.run();
    await ff.done();
    return { success: true };
  });

  server.tool(
    "reverse_video",
    "Reverse video playback (play backwards). Toggle operation — reversing twice restores original. Max 300s due to memory buffering.",
    {
      asset_id: z.string().describe("Asset ID (e.g. vid-my-video)"),
      project_slug: z.string().describe("Project slug"),
    },
    async ({ asset_id, project_slug }) => {
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

        const duration = await getVideoDuration(videoPath);
        if (duration > MAX_DURATION_SECONDS) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: `Video is ${duration.toFixed(1)}s — reverse requires buffering all frames in memory. Maximum supported duration is ${MAX_DURATION_SECONDS}s (5 minutes). Trim the video first.`,
            }],
          };
        }

        const hasAudio = await hasAudioStream(videoPath);
        const tempPath = join(assetDir, "original_reversed.mp4");
        const jobId = `reverse-${asset_id}-${Date.now()}`;

        await queue.enqueueAndWait(jobId, {
          type: "reverse_video",
          inputPath: videoPath,
          outputPath: tempPath,
          hasAudio,
        });

        await unlink(videoPath);
        await rename(tempPath, videoPath);

        await fs.commitOperation("reverse", asset_id, {}, project_slug);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ asset_id }),
          }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Reverse failed: ${msg}` }],
        };
      } finally {
        await fs.releaseLock(assetDir);
      }
    },
  );
}
