import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

// "Skip the swap, use the original source frame as-is" for one frame of a plan
// scene. Writes scenes[N].frame_source.image{1|2}; when true the scene's video
// gen uses @plan/s{N}-image{F}-source.jpg as that keyframe instead of a swapped
// image (the canvas "skip -> source" action on the swap tile). Setting it true
// also nulls any selected swap for that frame so the two states never conflict;
// variants are kept so the user can still pick one later (which re-points the
// swap and clears this flag client-side).
type PlanScene = {
  start: number;
  end: number;
  visual: string;
  frame_source?: { image1?: boolean; image2?: boolean } | null;
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
  frame_index: z.union([z.literal(1), z.literal(2)]).describe("1 = first-frame, 2 = last-frame"),
  use_source: z
    .boolean()
    .describe("true = skip the swap and use the original source frame as this keyframe; false = clear the flag (frame falls back to its swap / idle)"),
};

export function setPlanSceneFrameSourceDef(fs: VideocityFs): ToolDef {
  return {
    name: "set_plan_scene_frame_source",
    description:
      "Toggle whether a plan scene's frame skips the character swap and uses the original source frame as-is for the video. Writes scenes[N].frame_source.image{1|2}; when true also nulls scenes[N].swap.image{1|2} so the states don't conflict. Returns the updated sidecar.",
    schema,
    handler: async (args) => {
      const { project_slug, scene_index, frame_index, use_source } = args as {
        project_slug: string;
        scene_index: number;
        frame_index: 1 | 2;
        use_source: boolean;
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

      const slotKey = `image${frame_index}` as "image1" | "image2";
      const acceptedKey = `image${frame_index}_accepted` as "image1_accepted" | "image2_accepted";

      const nextScene: PlanScene = { ...scene };
      const frameSource = { ...(scene.frame_source ?? {}) };
      if (use_source) {
        frameSource[slotKey] = true;
        // Skipping to source overrides any selected swap for this frame; null it
        // so display/gate/gen are unambiguous (variants are preserved).
        if (scene.swap) {
          nextScene.swap = { ...scene.swap, [slotKey]: null, [acceptedKey]: false };
        }
      } else {
        delete frameSource[slotKey];
      }
      nextScene.frame_source = Object.keys(frameSource).length > 0 ? frameSource : undefined;
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
          text: JSON.stringify({ scene_index, frame_index, use_source, sidecar: plan }),
        }],
      };
    },
  };
}
