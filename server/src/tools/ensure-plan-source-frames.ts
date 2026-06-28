import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";

// Backfills missing per-scene source frames for a char_swap plan. The frames are
// normally extracted at /plan-vis time; this recovers plans where that step
// failed (e.g. a flaky ffmpeg run) or that predate it — without re-running the
// vision analysis. Idempotent: frames already on disk are left untouched.
export function ensurePlanSourceFramesDef(): ToolDef {
  return {
    name: "ensure_plan_source_frames",
    description:
      "Idempotently extract any missing per-scene source frames (plan/sN-imageM-source.jpg) for a char_swap plan from its source video. No-op for frames already present. Use to backfill a plan whose frames failed to extract at /plan-vis time, without re-running the vision analysis.",
    schema: { project_slug: z.string().describe("Project slug") },
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };
      const jobId = `ensure-plan-frames-${project_slug}-${Date.now()}`;
      try {
        const result = await queue.enqueueAndWait<{ success?: boolean }>(jobId, {
          type: "ensure_plan_source_frames",
          projectSlug: project_slug,
        } as unknown as Record<string, unknown>);
        return { content: [{ type: "text" as const, text: JSON.stringify(result ?? { success: true }) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    },
  };
}
