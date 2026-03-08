import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z } from "zod";
import { join, extname } from "node:path";
import { queue } from "../queue.js";
import { getFFmpeggy } from "../ffmpeg.js";
import type { ToolDef } from "./tool-def.js";

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "avi", "mkv"]);
const MAX_DURATION_SECONDS = 300;

function findVideoFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const videos = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
  });
  return videos.find((f) => f.name.startsWith("original")) ?? videos[0] ?? null;
}

async function hasAudioStream(filePath: string): Promise<boolean> {
  const probe = await getFFmpeggy().probe(filePath);
  return probe.streams.some((s) => s.codec_type === "audio");
}

async function getVideoDuration(filePath: string): Promise<number> {
  const probe = await getFFmpeggy().probe(filePath);
  return parseFloat(probe.format.duration);
}

export function reverseVideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "reverse_video",
    description: "Reverse video playback (play backwards). Toggle operation — reversing twice restores original. Max 300s due to memory buffering.",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. vid-my-video)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as { asset_id: string; project_slug: string };
      const manifestResult = await fs.getManifest(asset_id, project_slug);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const manifest = manifestResult.value;
      const videoFile = findVideoFile(manifest.files);
      if (!videoFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No video file found in asset ${asset_id}` }],
        };
      }

      const assetDir = manifest.path;
      const videoPath = join(assetDir, videoFile.name);

      const duration = await getVideoDuration(videoPath);
      if (duration > MAX_DURATION_SECONDS) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Video is ${duration.toFixed(1)}s — reverse requires buffering all frames in memory. Maximum supported duration is ${MAX_DURATION_SECONDS}s (5 minutes). Trim the video first.`,
          }],
        };
      }

      const hasAudio = await hasAudioStream(videoPath);
      const tempPath = join(assetDir, "original_reversed.mp4");
      const jobId = `reverse-${asset_id}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "reverse_video",
        inputPath: videoPath,
        outputPath: tempPath,
        hasAudio,
        assetId: asset_id,
        assetDir,
        projectSlug: project_slug,
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id, job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}

export function registerReverseVideoTool(server: McpServer, fs: ClipfirstFs): void {
  const def = reverseVideoDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
