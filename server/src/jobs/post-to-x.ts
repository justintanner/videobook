import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { postToX, prepareXPublication, type PostToXResult } from "../x/post-to-x.js";
import type { XPostFollowup } from "../x/post-contract.js";

interface PostToXJobPayload {
  type: "post_to_x";
  assetId?: string;
  postCellId?: string;
  bookId: string;
  text?: string;
  orientation?: "portrait" | "landscape";
  scheduleId?: string;
  scheduledFor?: string;
  followups?: XPostFollowup[];
}

export function registerPostToXJob(engine: Engine): void {
  registerJobHandler("post_prepare_x", async (payload, context) => prepareXPublication({ engine, publicationKey: `job:${context.jobId}`, ...(payload as unknown as PostToXJobPayload) }));
  registerJobHandler("post_to_x", async (payload, context): Promise<PostToXResult> => {
    const {
      assetId,
      postCellId,
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
      publicationKey: scheduleId ? `schedule:${scheduleId}` : `job:${context.jobId}`,
      signal: context.signal,
      assetId,
      postCellId,
      bookId,
      text,
      orientation,
      scheduleId,
      scheduledFor,
      followups,
    });
  });
}
