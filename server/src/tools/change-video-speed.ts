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
interface ProbeResult {
  streams: ProbeStream[];
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
const SPEED_MIN = 0.25;
const SPEED_MAX = 4.0;
const ATEMPO_MIN = 0.5;
const H264_MEDIUM = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-level:v", "4.0"];
const AUDIO_OPTS = ["-c:a", "aac", "-b:a", "192k"];

function findVideoFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const videos = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
  });
  return videos.find((f) => f.name.startsWith("original")) ?? videos[0] ?? null;
}

function validateSpeed(speed: number): string | null {
  if (speed === 1.0) return "Speed 1.0 is a no-op — nothing to change";
  if (speed < SPEED_MIN || speed > SPEED_MAX) return `Speed must be between ${SPEED_MIN} and ${SPEED_MAX}, got ${speed}`;
  return null;
}

function buildAtempoChain(speed: number): string[] {
  const filters: string[] = [];
  let remaining = speed;

  while (remaining < ATEMPO_MIN) {
    filters.push(`atempo=${ATEMPO_MIN}`);
    remaining /= ATEMPO_MIN;
  }

  filters.push(`atempo=${remaining}`);
  return filters;
}

function buildSpeedOutputOptions(speed: number, hasAudio: boolean): string[] {
  const videoFilter = `setpts=PTS/${speed}`;
  const opts = ["-filter:v", videoFilter];

  if (hasAudio) {
    const atempoChain = buildAtempoChain(speed);
    opts.push("-filter:a", atempoChain.join(","));
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

export function registerChangeVideoSpeedTool(server: McpServer, fs: ClipfirstFs): void {
  registerJobHandler("change_video_speed", async (payload) => {
    const { inputPath, outputPath, speed, hasAudio } = payload as {
      inputPath: string;
      outputPath: string;
      speed: number;
      hasAudio: boolean;
    };

    const outputOptions = buildSpeedOutputOptions(speed, hasAudio);

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
    "change_video_speed",
    "Change video playback speed (speed up or slow down). Operates in-place with git versioning.",
    {
      asset_id: z.string().describe("Asset ID (e.g. vid-my-video)"),
      project_slug: z.string().describe("Project slug"),
      speed: z.number().describe("Speed multiplier (0.25–4.0). >1 = faster, <1 = slower."),
    },
    async ({ asset_id, project_slug, speed }) => {
      const speedError = validateSpeed(speed);
      if (speedError) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: speedError }],
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
        const tempPath = join(assetDir, "original_speed.mp4");
        const jobId = `speed-${asset_id}-${Date.now()}`;

        const hasAudio = await hasAudioStream(videoPath);

        await queue.enqueueAndWait(jobId, {
          type: "change_video_speed",
          inputPath: videoPath,
          outputPath: tempPath,
          speed,
          hasAudio,
        });

        await unlink(videoPath);
        await rename(tempPath, videoPath);

        await fs.commitOperation("speed", asset_id, { speed }, project_slug);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ asset_id, speed }),
          }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Speed change failed: ${msg}` }],
        };
      } finally {
        await fs.releaseLock(assetDir);
      }
    },
  );
}
