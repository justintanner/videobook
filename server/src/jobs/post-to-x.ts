import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { postToX, type PostToXResult } from "../x/post-to-x.js";
import type { XPostFollowup } from "../x/post-contract.js";

interface PostToXJobPayload {
  type: "post_to_x";
  assetId: string;
  bookId: string;
  text?: string;
  orientation?: "portrait" | "landscape";
  scheduleId?: string;
  scheduledFor?: string;
  followups?: XPostFollowup[];
}

export function registerPostToXJob(engine: Engine): void {
  registerJobHandler("post_to_x", async (payload): Promise<PostToXResult> => {
    const {
      assetId,
      bookId,
      text,
      orientation,
      scheduleId,
      scheduledFor,
      followups,
    } =
      payload as unknown as PostToXJobPayload;
    return await postToX({
      engine,
      assetId,
      bookId,
      text,
      orientation,
      scheduleId,
      scheduledFor,
      followups,
    });
  });
}
