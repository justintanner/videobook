import { z } from "zod";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { getPlanProgress } from "../plan-progress.js";

// Read the in-memory live streaming output of an in-flight plan_visualization
// analysis. The client polls this while a plan is generating to render the
// model's output "live". Returns { status: 'idle', text: '' } when there's no
// active or recent run for the project. This is a transient preview — the
// authoritative plan is read via read_plan once scenes land.
export function readPlanProgressDef(): ToolDef {
  return {
    name: "read_plan_progress",
    description:
      "Read the live streaming output of an in-flight plan_visualization analysis for a project. " +
      "Returns { status: 'generating'|'done'|'failed'|'idle', text } where text is the model's " +
      "output streamed so far. Poll while a plan is generating to show progress.",
    schema: {
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args): Promise<ToolResult> => {
      const { project_slug } = args as { project_slug: string };
      const progress = getPlanProgress(project_slug);
      const payload = progress
        ? { status: progress.status, text: progress.text, error: progress.error ?? null }
        : { status: "idle" as const, text: "", error: null };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      };
    },
  };
}
