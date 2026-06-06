import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import type { ScreenshotDialogPlanSidecar } from "../plan-types.js";
import type { ToolDef } from "./tool-def.js";

const schema = {
  project_slug: z.string().describe("Project slug"),
  scene_index: z.number().int().nonnegative().describe("Zero-based scene index in plan/.plan.json"),
  asset_id: z.string().describe("vid-* asset id to set as the scene's video output"),
};

export function replacePlanScreenshotDialogSceneVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "replace_plan_screenshot_dialog_scene_video",
    description:
      "Point a screenshots + dialog plan scene's video output at a vid-* asset and return the updated sidecar.",
    schema,
    handler: async (args) => {
      const { project_slug, scene_index, asset_id } = args as {
        project_slug: string;
        scene_index: number;
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

      const planRead = await fs.readFile("plan", ".plan.json", project_slug);
      if (!planRead.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No plan in ${project_slug}: ${planRead.error.message}` }],
        };
      }

      let plan: ScreenshotDialogPlanSidecar;
      try {
        plan = JSON.parse(Buffer.from(planRead.value).toString("utf-8")) as ScreenshotDialogPlanSidecar;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Invalid .plan.json: ${msg}` }],
        };
      }

      if (plan.formula !== "screenshot_dialog") {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Active plan is not a screenshots + dialog plan" }],
        };
      }

      const scene = plan.scenes[scene_index];
      if (!scene) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Scene index ${scene_index} out of range (have ${plan.scenes.length})`,
          }],
        };
      }

      plan.scenes[scene_index] = { ...scene, video: asset_id };
      const writeResult = await fs.writeFile(
        "plan",
        ".plan.json",
        JSON.stringify(plan, null, 2),
        project_slug,
      );
      if (!writeResult.ok) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Failed to update .plan.json: ${writeResult.error.message}`,
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            scene_index,
            asset_id,
            sidecar: plan,
          }),
        }],
      };
    },
  };
}
