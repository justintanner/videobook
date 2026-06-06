import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ScreenshotDialogPlanSidecar } from "../plan-types.js";
import type { ToolDef } from "./tool-def.js";

const schema = {
  project_slug: z.string().describe("Project slug"),
  screenshot_asset_ids: z.array(z.string()).min(1).describe("Ordered img-* screenshot assets"),
  dialog_blocks: z.array(z.string()).min(1).describe("Ordered dialog blocks, one per screenshot"),
};

export function planScreenshotDialogDef(_fs: VideocityFs): ToolDef {
  void _fs;
  return {
    name: "plan_screenshot_dialog",
    description:
      "Generate the active per-project screenshots + dialog plan. Accepts ordered img-* screenshots and matching dialog blocks, calls the planner model, and writes plan/index.md plus plan/.plan.json.",
    schema,
    handler: async (args) => {
      const { project_slug, screenshot_asset_ids, dialog_blocks } = args as {
        project_slug: string;
        screenshot_asset_ids: string[];
        dialog_blocks: string[];
      };
      if (screenshot_asset_ids.length !== dialog_blocks.length) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Expected ${screenshot_asset_ids.length} dialog block(s), got ${dialog_blocks.length}`,
          }],
        };
      }
      const jobId = `plan-screenshot-dialog-${project_slug}-${Date.now()}`;
      try {
        const sidecar = await queue.enqueueAndWait<ScreenshotDialogPlanSidecar>(
          jobId,
          {
            type: "plan_screenshot_dialog",
            projectSlug: project_slug,
            screenshotAssetIds: screenshot_asset_ids,
            dialogBlocks: dialog_blocks,
          },
          5 * 60_000,
        );
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              asset_id: "plan",
              scenes: sidecar.scenes.length,
              total_duration_s: sidecar.total_duration_s,
              sidecar,
            }),
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: msg }],
        };
      }
    },
  };
}
