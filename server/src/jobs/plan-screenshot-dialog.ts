import type { VideocityFs } from "vc-engine";
import { registerJobHandler } from "../queue.js";
import { generateScreenshotDialogPlan } from "../plan-screenshot-dialog.js";

type PlanScreenshotDialogPayload = {
  type: "plan_screenshot_dialog";
  projectSlug: string;
  screenshotAssetIds: string[];
  dialogBlocks: string[];
};

export function registerPlanScreenshotDialogJob(fs: VideocityFs): void {
  registerJobHandler("plan_screenshot_dialog", async (payload) => {
    const { projectSlug, screenshotAssetIds, dialogBlocks } = payload as PlanScreenshotDialogPayload;
    return generateScreenshotDialogPlan(fs, { projectSlug, screenshotAssetIds, dialogBlocks });
  });
}
