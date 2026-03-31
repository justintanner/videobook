import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import { findVideoFile } from "../media-files.js";
import type { ToolDef } from "./tool-def.js";

export function extendGrokImagineVideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "extend_grok_imagine_video",
    description: "Extend an existing video asset using Grok Imagine video extension. Creates a new vid- asset and enqueues a background job.",
    schema: {
      asset_id: z.string().optional().describe("Video asset ID (must be vid-*)"),
      video_slug: z.string().optional().describe("Video slug (e.g., '@vid-sunset'). Used as fallback when asset_id is not provided."),
      project_slug: z.string().describe("Project slug"),
      prompt: z.string().optional().describe("Optional prompt to guide video extension"),
      duration: z.enum(["6", "10", "15"]).optional().describe("Video duration in seconds"),
    },
    handler: async (args) => {
      const { asset_id: rawAssetId, video_slug, project_slug, prompt, duration } = args as {
        asset_id?: string;
        video_slug?: string;
        project_slug: string;
        prompt?: string;
        duration?: "6" | "10" | "15";
      };

      // Derive asset_id from video_slug if not provided directly
      const asset_id = rawAssetId ?? (video_slug?.replace(/^@/, "") || undefined);

      // Video extension is xAI-only
      if (!process.env.XAI_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "XAI_API_KEY environment variable is not set" }],
        };
      }

      if (!asset_id) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "asset_id or video_slug is required" }],
        };
      }

      if (!asset_id.startsWith("vid-")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `asset_id must start with vid-, got: ${asset_id}` }],
        };
      }

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

      const baseName = asset_id.startsWith("vid-") ? asset_id.slice(4) : asset_id;
      const videoName = `extend-${baseName}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      await writePendingTask(fs, vidAssetId, project_slug, {
        taskId: QUEUED_TASK_ID,
        taskType: "xai_grok_imagine_extend_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: { sourceVideoId: asset_id, ...(prompt !== undefined ? { prompt } : {}) },
      });

      const jobId = `grok-imagine-extend-video-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "extend_grok_imagine_video",
        sourceVideoId: asset_id,
        sourceVideoFilename: videoFile.name,
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(duration !== undefined ? { duration } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_video: asset_id,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

export function registerExtendGrokImagineVideoTool(server: McpServer, fs: ClipfirstFs): void {
  const def = extendGrokImagineVideoDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
