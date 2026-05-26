import type { VideocityFs } from "vc-engine";
import { registerJobHandler } from "../queue.js";
import { postToX, type PostToXResult } from "../x/post-to-x.js";

interface PostToXJobPayload {
  type: "post_to_x";
  assetId: string;
  projectSlug: string;
  text?: string;
  orientation?: "portrait" | "landscape";
  scheduleId?: string;
  scheduledFor?: string;
}

export function registerPostToXJob(fs: VideocityFs): void {
  registerJobHandler("post_to_x", async (payload): Promise<PostToXResult> => {
    const { assetId, projectSlug, text, orientation, scheduleId, scheduledFor } =
      payload as unknown as PostToXJobPayload;
    return await postToX({
      fs,
      assetId,
      projectSlug,
      text,
      orientation,
      scheduleId,
      scheduledFor,
    });
  });
}
