import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VideocityFs } from "vc-engine";
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
  asset_id: z.string().describe("vid-* asset id to set as the scene's video output"),
  auto_accept: z.boolean().optional().describe("Default false. Set true to auto-accept the swap (e.g. when the user explicitly drops a known-good clip)."),
};

export function replacePlanSceneVideoSwapDef(fs: VideocityFs): ToolDef {
  return {
    name: "replace_plan_scene_video_swap",
    description:
      "Point a plan scene's video output at a vid-* asset (typically the freshly-generated seedance output, or one the user dropped onto the slot). Updates scenes[N].swap.video and optionally toggles video_accepted. Returns the updated sidecar.",
    schema,
    handler: async (args) => {
      const { project_slug, scene_index, asset_id, auto_accept } = args as {
        project_slug: string;
        scene_index: number;
        asset_id: string;
        auto_accept?: boolean;
      };
      const shouldAutoAccept = auto_accept === true;

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
      swap.video = asset_id;
      swap.video_accepted = shouldAutoAccept;
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
            asset_id,
            sidecar: plan,
          }),
        }],
      };
    },
  };
}

export function registerReplacePlanSceneVideoSwapTool(server: McpServer, fs: VideocityFs): void {
  const def = replacePlanSceneVideoSwapDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
