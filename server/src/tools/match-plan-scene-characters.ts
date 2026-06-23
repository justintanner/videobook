import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";

type PlanSidecar = {
  scenes: Array<{ start: number; end: number }>;
  characters: Array<{ asset_id: string; name: string; description: string }>;
};

const schema = {
  project_slug: z.string().describe("Project slug"),
  scene_index: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Zero-based scene index to match. Omit to auto-match every scene."),
};

export function matchPlanSceneCharactersDef(fs: VideocityFs): ToolDef {
  return {
    name: "match_plan_scene_characters",
    description:
      "Vision auto-match: classify which of the plan's reference characters appear in each scene's source frames and persist that as the per-frame wiring (scenes[N].frame_characters). Runs in the background. Omit scene_index to match all scenes. Re-read the plan to pick up the result.",
    schema,
    handler: async (args) => {
      const { project_slug, scene_index } = args as {
        project_slug: string;
        scene_index?: number;
      };

      if (!process.env.OPENAI_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
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
      if (!plan.characters || plan.characters.length === 0) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Plan has no characters to match" }],
        };
      }
      if (scene_index !== undefined && !plan.scenes[scene_index]) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Scene index ${scene_index} out of range (have ${plan.scenes.length})`,
          }],
        };
      }

      const scenesTargeted = scene_index === undefined ? plan.scenes.length : 1;
      const jobId = `match-plan-characters-${project_slug}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "match_plan_characters",
        projectSlug: project_slug,
        sceneIndex: scene_index ?? null,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            job_id: jobId,
            status: "enqueued",
            scenes_targeted: scenesTargeted,
          }),
        }],
      };
    },
  };
}
