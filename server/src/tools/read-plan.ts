import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import type { ToolDef, ToolResult } from "./tool-def.js";

interface PlanScene {
  start: number;
  end: number;
  visual: string;
  // Per-scene frames sampled from the source's original_frames/ at plan-vis
  // time; persisted so the audit view can render exactly what was sent. Older
  // plans pre-dating the audit feature lack this field.
  frames?: Array<{ name: string; t: number }>;
}

interface PlanSidecar {
  scenes: PlanScene[];
  total_duration_s: number;
  max_scene_seconds: number;
  source_asset_id: string;
  characters: Array<{ asset_id: string; name: string; description: string }>;
  model: string;
  analysis_prompt?: string;
  user_context?: string;
  word_count?: number;
}

export function readPlanDef(fs: VideocityFs): ToolDef {
  return {
    name: "read_plan",
    description:
      "Read the per-project visualization plan sidecar (plan/.plan.json). " +
      "Returns the parsed structured plan or an error if no plan exists yet (run /plan-vis first).",
    schema: {
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args): Promise<ToolResult> => {
      const { project_slug } = args as { project_slug: string };
      const result = await fs.readMetadata<PlanSidecar>("plan", "plan", project_slug);
      if (!result.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: result.error.message }],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
      };
    },
  };
}

