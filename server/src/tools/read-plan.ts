import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef, ToolResult } from "./tool-def.js";

interface PlanScene {
  start: number;
  end: number;
  visual: string;
  // Per-scene spoken dialog, sliced from the transcript at plan-vis time. Older
  // plans pre-dating this field lack it; the client guards with `?? ''`.
  dialog?: string;
  // Per-scene frames sampled from the source's original_frames/ at plan-vis
  // time; persisted so the audit view can render exactly what was sent. Older
  // plans pre-dating the audit feature lack this field.
  frames?: Array<{ name: string; t: number }>;
}

interface PlanSidecar {
  formula?: string;
  scenes: PlanScene[];
  total_duration_s: number;
  max_scene_seconds: number;
  source_asset_id: string;
  characters: Array<{ asset_id: string; name: string; description: string }>;
  model: string;
  analysis_prompt?: string;
  user_context?: string;
  word_count?: number;
  generation_status?: "draft" | "generating" | "ready" | "failed";
  generation_error?: string;
  failed_at?: string;
}

function missingPlanResponse(): Record<string, unknown> {
  return {
    exists: false,
    formula: null,
    scenes: [],
    total_duration_s: 0,
    max_scene_seconds: 0,
    source_asset_id: null,
    characters: [],
    model: null,
    generation_status: "missing",
  };
}

function isMissingPlanError(error: { code?: string; message: string }): boolean {
  return error.code === "NOT_FOUND" || error.message.includes("File not found: plan/.plan.json");
}

export function readPlanDef(fs: VideocityFs): ToolDef {
  return {
    name: "read_plan",
    description:
      "Read the per-project visualization plan sidecar (plan/.plan.json). " +
      "Returns the parsed structured plan, or exists:false when no plan exists yet.",
    schema: {
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args): Promise<ToolResult> => {
      const { project_slug } = args as { project_slug: string };
      const project = await fs.getProject(project_slug);
      if (!project.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: project.error.message }],
        };
      }

      const result = await fs.readMetadata<PlanSidecar>("plan", "plan", project_slug);
      if (!result.ok) {
        if (isMissingPlanError(result.error)) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(missingPlanResponse()) }],
          };
        }
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: result.error.message }],
        };
      }
      const sidecar = result.value.formula ? result.value : { ...result.value, formula: "char_swap" };
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ exists: true, ...sidecar }),
        }],
      };
    },
  };
}
