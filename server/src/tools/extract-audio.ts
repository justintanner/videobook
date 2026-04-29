import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-engine";
import { z } from "zod";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { queue } from "../queue.js";
import { findVideoFile } from "clipfirst-engine";
import type { ToolDef } from "./tool-def.js";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const FFPROBE: string = require("ffprobe-static").path;

async function hasAudioStream(filePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    filePath,
  ]);
  const data = JSON.parse(stdout);
  return (data.streams as Array<Record<string, unknown>>)?.some(
    (s) => s.codec_type === "audio",
  ) ?? false;
}

function deriveAudioName(videoAssetId: string): string {
  const baseName = videoAssetId.startsWith("vid-") ? videoAssetId.slice(4) : videoAssetId;
  return `ext-${baseName}`;
}

export function extractAudioDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "extract_audio",
    description: "Extract the audio track from a video asset as a new audio asset (MP3). Creates an aud- asset with original.mp3.",
    schema: {
      asset_id: z.string().describe("Video asset ID (e.g. vid-my-video)"),
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

      const videoPath = join(manifest.path, videoFile.name);

      let audioPresent: boolean;
      try {
        audioPresent = await hasAudioStream(videoPath);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to probe video: ${msg}` }],
        };
      }

      if (!audioPresent) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Video has no audio stream: ${asset_id}` }],
        };
      }

      const audioName = deriveAudioName(asset_id);
      const assetResult = await fs.createAsset("aud", audioName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create audio asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: audioAssetId, path: audioAssetDir } = assetResult.value;

      const outputPath = join(audioAssetDir, "original.mp3");
      const jobId = `extract-audio-${audioAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "extract_audio",
        inputPath: videoPath,
        outputPath,
        audioAssetId,
        audioAssetDir,
        sourceVideoId: asset_id,
        projectSlug: project_slug,
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ audio_asset_id: audioAssetId, source_video: asset_id, job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}

export function registerExtractAudioTool(server: McpServer, fs: ClipfirstFs): void {
  const def = extractAudioDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
