import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { readStoryboardVideoPlan, writeStoryboardVideoPlan } from "../plan-storyboard-video.js";
import type { ToolDef } from "./tool-def.js";

const schema = {
  project_slug: z.string().describe("Project slug"),
  asset_id: z.string().describe("vid-* asset id to set as the plan's video output"),
};

export function replacePlanStoryboardVideoVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "replace_plan_storyboard_video_video",
    description:
      "Point an image -> storyboard -> video plan at a generated vid-* asset and return the updated sidecar.",
    schema,
    handler: async (args) => {
      const { project_slug, asset_id } = args as {
        project_slug: string;
        asset_id: string;
      };

      if (!asset_id.startsWith("vid-")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `asset_id must be a vid-* asset, got: ${asset_id}` }],
        };
      }

      const assetDir = await fs.resolveAssetDir(asset_id, project_slug);
      if (!assetDir.ok) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Asset ${asset_id} not found in ${project_slug}: ${assetDir.error.message}`,
          }],
        };
      }

      try {
        const plan = await readStoryboardVideoPlan(fs, project_slug);
        const next = { ...plan, video_asset_id: asset_id };
        await writeStoryboardVideoPlan(fs, project_slug, next);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              asset_id,
              sidecar: next,
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
