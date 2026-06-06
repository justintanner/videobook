import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import { generateStoryboardVideoPlan } from "../plan-storyboard-video.js";
import type { StoryboardVideoPlanSidecar } from "../plan-types.js";
import type { ToolDef } from "./tool-def.js";

const schema = {
  project_slug: z.string().describe("Project slug"),
  source_image_asset_id: z.string().optional().describe("Primary img-* source image used as the analysis/reference image"),
  source_image_asset_ids: z.array(z.string()).optional().describe("Ordered img-* source images. First image is primary; later images are additional references for storyboard and video."),
  storyboard_brief: z.string().optional().describe("User direction for what the image-derived storyboard should be about"),
  loop_video: z.boolean().optional().describe("Whether the storyboard and video should be designed as a seamless loop"),
  storyboard_prompt: z.string().optional().describe("Editable GPT Image 2 storyboard prompt"),
  video_prompt: z.string().optional().describe("Editable final video prompt"),
  video_model: z.enum(["generate_seedance2_video", "generate_seedance2_fast_video", "generate_grok_imagine_video"]).optional().describe("Video tool to use for the final storyboard render"),
  duration_s: z.number().int().min(4).max(15).optional().describe("Final video duration in seconds"),
};

export function planStoryboardVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "plan_storyboard_video",
    description:
      "Create or update the active image -> storyboard -> video plan from one or more img-* source images. Writes plan/index.md plus plan/.plan.json.",
    schema,
    handler: async (args) => {
      const {
        project_slug,
        source_image_asset_id,
        source_image_asset_ids,
        storyboard_brief,
        loop_video,
        storyboard_prompt,
        video_prompt,
        video_model,
        duration_s,
      } = args as {
        project_slug: string;
        source_image_asset_id?: string;
        source_image_asset_ids?: string[];
        storyboard_brief?: string;
        loop_video?: boolean;
        storyboard_prompt?: string;
        video_prompt?: string;
        video_model?: "generate_seedance2_video" | "generate_seedance2_fast_video" | "generate_grok_imagine_video";
        duration_s?: number;
      };

      try {
        const sidecar = await generateStoryboardVideoPlan(fs, {
          projectSlug: project_slug,
          ...(source_image_asset_id !== undefined ? { sourceImageAssetId: source_image_asset_id } : {}),
          ...(source_image_asset_ids !== undefined ? { sourceImageAssetIds: source_image_asset_ids } : {}),
          ...(storyboard_brief !== undefined ? { storyboardBrief: storyboard_brief } : {}),
          ...(loop_video !== undefined ? { loopVideo: loop_video } : {}),
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
