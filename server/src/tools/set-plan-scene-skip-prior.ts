import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

// A scene's last-frame (frame 2) swap normally threads the first-frame swap as a
// continuity reference (Image N). `skip_prior_swap` turns that off so the next
// frame-2 swap runs without it — the "delete the prior-continuity input" action
// on the canvas. Only meaningful for frame 2; frame 1 has no in-scene prior.
type PlanScene = {
  start: number;
  end: number;
  visual: string;
  skip_prior_swap?: boolean;
};

type PlanSidecar = {
  scenes: PlanScene[];
  source_asset_id: string;
  characters: Array<{ asset_id: string; name: string; description: string }>;
  total_duration_s: number;
  max_scene_seconds: number;
  model: string;
};

const schema = {
  project_slug: z.string().describe("Project slug"),
  scene_index: z.number().int().nonnegative().describe("Zero-based scene index in plan/.plan.json"),
  skip: z.boolean().describe("true = drop the prior-frame continuity reference from this scene's last-frame (frame 2) swap; false = restore it"),
};

export function setPlanSceneSkipPriorDef(fs: VideocityFs): ToolDef {
  return {
    name: "set_plan_scene_skip_prior",
    description:
      "Toggle whether a plan scene's last-frame (frame 2) swap threads the first-frame swap as a continuity reference. Writes scenes[N].skip_prior_swap; when true the frame-2 swap drops the prior-swap input and the continuity prompt clause. Returns the updated sidecar.",
    schema,
    handler: async (args) => {
      const { project_slug, scene_index, skip } = args as {
        project_slug: string;
        scene_index: number;
        skip: boolean;
      };

      const planRead = await fs.readFile("plan", ".plan.json", project_slug);
      if (!planRead.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No plan in ${project_slug}: ${planRead.error.message}` }],
        };
      }
      let plan: PlanSidecar;
      try {
        plan = JSON.parse(Buffer.from(planRead.value).toString("utf-8")) as PlanSidecar;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Invalid .plan.json: ${msg}` }],
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

      const nextScene: PlanScene = { ...scene };
      if (skip) {
        nextScene.skip_prior_swap = true;
      } else {
        delete nextScene.skip_prior_swap;
      }
      plan.scenes[scene_index] = nextScene;

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
          text: JSON.stringify({ scene_index, skip, sidecar: plan }),
        }],
      };
    },
  };
}
