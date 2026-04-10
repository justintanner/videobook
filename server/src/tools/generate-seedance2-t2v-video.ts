import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { queue } from "../queue.js";
import { writePendingTask, QUEUED_TASK_ID } from "../jobs/pending-task.js";
import type { ToolDef } from "./tool-def.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

export function generateSeedance2T2vVideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_seedance2_t2v_video",
    description: "Generate a video using ByteDance Seedance 2.0 Fast in text-to-video mode (no reference inputs). Creates a new vid- asset and enqueues a background job.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      prompt: z.string().describe("Video description (3-2500 characters)"),
      aspect_ratio: z.enum(["1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "adaptive"]).optional().describe("Output aspect ratio"),
      resolution: z.enum(["480p", "720p"]).optional().describe("Output resolution"),
      duration: z.string().optional().describe("Video duration in seconds (4-15)"),
      generate_audio: z.boolean().optional().describe("Generate accompanying audio (default true)"),
      return_last_frame: z.boolean().optional().describe("Return the final frame as an image (default false)"),
      web_search: z.boolean().optional().describe("Use web search for enhanced grounding (default false)"),
      _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
    },
    handler: async (args) => {
      const {
        project_slug, prompt, aspect_ratio, resolution, duration,
        generate_audio, return_last_frame, web_search,
      } = args as {
        project_slug: string;
        prompt: string;
        aspect_ratio?: string;
        resolution?: "480p" | "720p";
        duration?: string;
        generate_audio?: boolean;
        return_last_frame?: boolean;
        web_search?: boolean;
      };

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const videoName = `seedance2-${slugify(prompt) || String(Date.now())}`;
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
        taskType: "seedance2_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        projectSlug: project_slug,
        createdAt: new Date().toISOString(),
        meta: {
          prompt,
          mode: "t2v",
          ...(return_last_frame !== undefined ? { return_last_frame } : {}),
        },
      });

      const jobId = `seedance2-t2v-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_seedance2_t2v_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(generate_audio !== undefined ? { generate_audio } : {}),
        ...(return_last_frame !== undefined ? { return_last_frame } : {}),
        ...(web_search !== undefined ? { web_search } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
