import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "vc-engine";
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
    video?: string | null;
    video_accepted?: boolean;
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
  accepted: z.boolean().describe("True to mark the scene's video swap as accepted, false to clear acceptance"),
};

export function acceptPlanSceneVideoSwapDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "accept_plan_scene_video_swap",
    description:
      "Toggle the human-acceptance flag on a plan scene's video output. Sets scenes[N].swap.video_accepted in plan/.plan.json and returns the updated sidecar. The PlanViewer Accept / Regen UI flips this; the client also auto-extracts the last frame on accept and prefills the next scene's first-frame swap.",
    schema,
    handler: async (args) => {
      const { project_slug, scene_index, accepted } = args as {
        project_slug: string;
        scene_index: number;
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
      if (!swap.video) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `No video asset present at scenes[${scene_index}].swap.video — generate one first.`,
          }],
        };
      }
      swap.video_accepted = accepted;
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
            accepted,
            sidecar: plan,
          }),
        }],
      };
    },
  };
}

export function registerAcceptPlanSceneVideoSwapTool(server: McpServer, fs: ClipfirstFs): void {
  const def = acceptPlanSceneVideoSwapDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
