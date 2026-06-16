import type { VideocityFs } from "videocity-engine";
import { registerJobHandler } from "../queue.js";
import { withLocalLease } from "./_lease.js";
import { regenerateClipShowSegment } from "../plan-clip-show.js";
import type { ClipShowPlanSidecar } from "../plan-types.js";

type RegenerateClipShowSegmentPayload = {
  type: "regenerate_clip_show_segment";
  // The singleton "plan" asset is leased so concurrent regenerations of the
  // same plan serialize on its write, and the host avatar doesn't flicker.
  assetId: "plan";
  projectSlug: string;
  segmentIndex: number;
  jokeType: string | null;
  newImageAssetId: string | null;
};

export function registerRegenerateClipShowSegmentJob(fs: VideocityFs): void {
  registerJobHandler("regenerate_clip_show_segment", async (payload, ctx) => {
    const { assetId, projectSlug, segmentIndex, jokeType, newImageAssetId } =
      payload as RegenerateClipShowSegmentPayload;

    return withLocalLease(fs, projectSlug, assetId, ctx, "analyze", async () => {
      const sidecar: ClipShowPlanSidecar = await regenerateClipShowSegment(fs, {
        projectSlug,
        segmentIndex,
        jokeType,
        newImageAssetId,
      });
      return { success: true, sidecar };
    });
  });
}
