import type { VideocityFs } from "videocity-engine";
import { registerJobHandler } from "../queue.js";
import { withLocalLease } from "./_lease.js";
import { generateClipShowPlan } from "../plan-clip-show.js";

type PlanClipShowPayload = {
  type: "plan_clip_show";
  assetId: string;
  projectSlug: string;
  characterAssetId: string;
  clipAssetIds: string[];
  showBrief: string | null;
  tone: string | null;
};

export function registerPlanClipShowJob(fs: VideocityFs): void {
  registerJobHandler("plan_clip_show", async (payload, ctx) => {
    const { assetId, projectSlug, characterAssetId, clipAssetIds, showBrief, tone } =
      payload as PlanClipShowPayload;

    // Lease the host character (the show's subject). generateClipShowPlan
    // writes the result to the "plan" asset, creating it if needed.
    return withLocalLease(fs, projectSlug, assetId, ctx, "analyze", async () => {
      const sidecar = await generateClipShowPlan(fs, {
        projectSlug,
        characterAssetId,
        clipAssetIds,
        ...(showBrief !== null ? { showBrief } : {}),
        ...(tone !== null ? { tone } : {}),
      });
      return { success: true, segments: sidecar.segments.length };
    });
  });
}
