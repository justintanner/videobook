import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-engine";
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
  asset_id: z.string().describe("img-* asset id to point this swap at (e.g. one already created via /api/upload)"),
};

export function replacePlanSceneFrameSwapDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "replace_plan_scene_frame_swap",
    description:
      "Point a plan scene's swap frame at an existing img-* asset (typically one the user just dropped in via /api/upload). Updates scenes[N].swap.image{1|2} and marks it accepted=true since the user explicitly chose this image. Returns the updated sidecar.",
    schema,
    handler: async (args) => {
      const { project_slug, scene_index, frame_index, asset_id } = args as {
        project_slug: string;
        scene_index: number;
        frame_index: 1 | 2;
        asset_id: string;
      };

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
      swap[`image${frame_index}` as "image1" | "image2"] = asset_id;
      // The user explicitly picked this image — auto-accept it.
      swap[`image${frame_index}_accepted` as "image1_accepted" | "image2_accepted"] = true;
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
            asset_id,
            sidecar: plan,
          }),
        }],
      };
    },
  };
}

export function registerReplacePlanSceneFrameSwapTool(server: McpServer, fs: ClipfirstFs): void {
  const def = replacePlanSceneFrameSwapDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
