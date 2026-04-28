import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile, findAudioFile } from "../media-files.js";
import type { ToolDef } from "./tool-def.js";

export function replaceVideoAudioDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "replace_video_audio",
    description: "Replace the audio track of a video asset in-place with audio from an aud- asset. Operates on the vid- asset's original.mp4 with git versioning. Existing per-orientation renders are now stale — re-run /render before /final.",
    schema: {
      asset_id: z.string().describe("Video asset whose audio is being replaced (vid-*)"),
      audio_asset_id: z.string().describe("Audio asset providing the new audio track (aud-*)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, audio_asset_id, project_slug } = args as {
        asset_id: string;
        audio_asset_id: string;
        project_slug: string;
      };

      if (!asset_id.startsWith("vid-")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `asset_id must be a vid-* asset, got: ${asset_id}` }],
        };
      }
      if (!audio_asset_id.startsWith("aud-")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `audio_asset_id must be an aud-* asset, got: ${audio_asset_id}` }],
        };
      }

      const videoManifest = await fs.getManifest(asset_id, project_slug);
      if (!videoManifest.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: videoManifest.error.message }],
        };
      }
      const videoFile = findVideoFile(videoManifest.value.files);
      if (!videoFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No video file found in asset ${asset_id}` }],
        };
      }

      const audioManifest = await fs.getManifest(audio_asset_id, project_slug);
      if (!audioManifest.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: audioManifest.error.message }],
        };
      }
      const audioFile = findAudioFile(audioManifest.value.files, audio_asset_id);
      if (!audioFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No audio file found in asset ${audio_asset_id}` }],
        };
      }

      const assetDir = videoManifest.value.path;
      const videoPath = join(assetDir, videoFile.name);
      const audioPath = join(audioManifest.value.path, audioFile.name);
      const tempPath = join(assetDir, "original_audio_replaced.mp4");
      const jobId = `replace-audio-${asset_id}-${Date.now()}`;

      try {
        await queue.enqueueAndWait(jobId, {
          type: "replace_video_audio",
          inputPath: videoPath,
          audioPath,
          outputPath: tempPath,
          assetId: asset_id,
          assetDir,
          audioAssetId: audio_asset_id,
          projectSlug: project_slug,
        } as unknown as Record<string, unknown>);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Replace audio failed: ${msg}` }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id, audio_asset_id, job_id: jobId, status: "completed" }),
        }],
      };
    },
  };
}

export function registerReplaceVideoAudioTool(server: McpServer, fs: ClipfirstFs): void {
  const def = replaceVideoAudioDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
