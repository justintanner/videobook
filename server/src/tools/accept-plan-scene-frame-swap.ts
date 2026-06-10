import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

type PlanScene = {
  start: number;
  end: number;
  visual: string;
  swap?: {
    image1: string | null;
    image2: string | null;
    image1_accepted?: boolean;
    image2_accepted?: boolean;
    image1_variants?: Record<string, string>;
    image2_variants?: Record<string, string>;
  } | null;
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
  frame_index: z.union([z.literal(1), z.literal(2)]).describe("1 = first-frame swap, 2 = last-frame swap"),
  accepted: z.boolean().describe("True to mark the swap as accepted, false to clear acceptance"),
};

export function acceptPlanSceneFrameSwapDef(fs: VideocityFs): ToolDef {
  return {
    name: "accept_plan_scene_frame_swap",
    description:
      "Toggle the human-acceptance flag on a plan scene's swap frame. Sets scenes[N].swap.image{1|2}_accepted in plan/.plan.json and returns the updated sidecar. Used by the PlanViewer Accept / Regen UI to record review decisions.",
    schema,
    handler: async (args) => {
      const { project_slug, scene_index, frame_index, accepted } = args as {
        project_slug: string;
        scene_index: number;
        frame_index: 1 | 2;
        accepted: boolean;
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

      const swap = scene.swap ?? { image1: null, image2: null };
      if (!swap[`image${frame_index}` as "image1" | "image2"]) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `No swap asset present at scenes[${scene_index}].swap.image${frame_index} — generate one first.`,
          }],
        };
      }
      swap[`image${frame_index}_accepted` as "image1_accepted" | "image2_accepted"] = accepted;
      plan.scenes[scene_index] = { ...scene, swap };

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
            frame_index,
            accepted,
            sidecar: plan,
          }),
        }],
      };
    },
  };
}

