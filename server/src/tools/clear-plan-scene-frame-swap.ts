import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

// Mutable shape of one frame's swap state. Cleared back to idle by this tool;
// the per-frame *_variants and *_accepted siblings are dropped too so the node
// returns to a clean "no swap yet" state.
type SwapState = {
  image1: string | null;
  image2: string | null;
  image1_accepted?: boolean;
  image2_accepted?: boolean;
  image1_variants?: Record<string, string>;
  image2_variants?: Record<string, string>;
  video?: string | null;
};

type PlanScene = {
  start: number;
  end: number;
  visual: string;
  swap?: SwapState | null;
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
  frame_index: z.union([z.literal(1), z.literal(2)]).describe("1 = first-frame swap (image1), 2 = last-frame swap (image2)"),
};

export function clearPlanSceneFrameSwapDef(fs: VideocityFs): ToolDef {
  return {
    name: "clear_plan_scene_frame_swap",
    description:
      "Reset a plan scene's swap frame to idle: nulls scenes[N].swap.image{1|2}, drops its accepted flag, and clears that frame's image{1|2}_variants. The auto-extracted source still on disk is untouched, so a fresh Run regenerates the frame. Returns the updated sidecar.",
    schema,
    handler: async (args) => {
      const { project_slug, scene_index, frame_index } = args as {
        project_slug: string;
        scene_index: number;
        frame_index: 1 | 2;
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

      const swap: SwapState = scene.swap ?? { image1: null, image2: null };
      swap[`image${frame_index}` as "image1" | "image2"] = null;
      delete swap[`image${frame_index}_accepted` as "image1_accepted" | "image2_accepted"];
      delete swap[`image${frame_index}_variants` as "image1_variants" | "image2_variants"];
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
          text: JSON.stringify({ scene_index, frame_index, sidecar: plan }),
        }],
      };
    },
  };
}
