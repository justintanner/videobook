import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import { generateStoryboardVideoPlan } from "../plan-storyboard-video.js";
import type { StoryboardVideoPlanSidecar } from "../plan-types.js";
import type { ToolDef } from "./tool-def.js";

const schema = {
  project_slug: z.string().describe("Project slug"),
  source_image_asset_id: z.string().describe("Single img-* source image used as the character/reference image"),
  storyboard_prompt: z.string().optional().describe("Editable GPT Image 2 storyboard prompt"),
  video_prompt: z.string().optional().describe("Editable Seedance 2 video prompt"),
  video_model: z.enum(["generate_seedance2_video", "generate_seedance2_fast_video"]).optional().describe("Seedance tool to use for the final video"),
  duration_s: z.number().int().min(4).max(15).optional().describe("Final video duration in seconds"),
};

export function planStoryboardVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "plan_storyboard_video",
    description:
      "Create or update the active image -> storyboard -> video plan from one img-* source image. Writes plan/index.md plus plan/.plan.json.",
    schema,
    handler: async (args) => {
      const {
        project_slug,
        source_image_asset_id,
        storyboard_prompt,
        video_prompt,
        video_model,
        duration_s,
      } = args as {
        project_slug: string;
        source_image_asset_id: string;
        storyboard_prompt?: string;
        video_prompt?: string;
        video_model?: "generate_seedance2_video" | "generate_seedance2_fast_video";
        duration_s?: number;
      };

      try {
        const sidecar = await generateStoryboardVideoPlan(fs, {
          projectSlug: project_slug,
          sourceImageAssetId: source_image_asset_id,
          ...(storyboard_prompt !== undefined ? { storyboardPrompt: storyboard_prompt } : {}),
          ...(video_prompt !== undefined ? { videoPrompt: video_prompt } : {}),
          ...(video_model !== undefined ? { videoModel: video_model } : {}),
          ...(duration_s !== undefined ? { durationS: duration_s } : {}),
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              asset_id: "plan",
              sidecar,
            }),
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: msg }],
        };
      }
    },
  };
}

export type PlanStoryboardVideoResult = {
  asset_id: "plan";
  sidecar: StoryboardVideoPlanSidecar;
};
