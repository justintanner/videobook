import { getPost, linkPost, savePostDraft, updatePost } from "../posts/post-store.js";
import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import { savePostToICloud } from "../posts/icloud-drive.js";
import { preparePostDownload } from "../posts/post-download.js";
import { createPostFor } from "../posts/post-target.js";
import type { NewPostArgs } from "../posts/post-target.js";
import type { PostPlatform } from "../posts/post-contract.js";
import { refreshPostMetrics } from "../posts/post-metrics.js";
import { draftPostCopy, postCopyResponses, readPostCopyContext, type PostCopyRequest } from "../posts/post-copy.js";
import { getApiKey } from "../api-key.js";

export interface PostDeliverJob {
  to: "icloud" | "download" | "draft";
  postCellId?: string;
  create?: NewPostArgs;
  caption?: string;
  platform?: PostPlatform;
  folder?: string;
}

async function deliverPost(engine: Engine, job: PostDeliverJob): Promise<unknown> {
  const post = job.postCellId ? getPost(engine, job.postCellId) : await createPostFor(engine, job.create ?? {});
  const draft = { caption: job.caption, platform: job.platform };
  return withNotebookMutation(`post:${post.id}`, async () => {
    if (job.to === "icloud") return { post: await savePostToICloud(engine, post.id, { ...draft, folder: job.folder }) };
    if (job.to === "download") return preparePostDownload(engine, post.id, draft);
    return { post: await savePostDraft(engine, post.id, draft) };
  });
}

export function registerPostRecordJobs(engine: Engine): void {
  registerJobHandler("post_deliver", async (payload) => deliverPost(engine, payload as unknown as PostDeliverJob));
  registerJobHandler("post_update", async (payload) => withNotebookMutation(`post:${payload.postCellId}`, () => updatePost(engine, String(payload.postCellId), payload.patch as Parameters<typeof updatePost>[2])));
  registerJobHandler("post_link", async (payload) => withNotebookMutation(`post:${payload.postCellId}`, () => linkPost(engine, String(payload.postCellId), String(payload.url), String(payload.postedAt))));
  registerJobHandler("post_copy", async (payload, context) => {
    const post = getPost(engine, String(payload.postCellId));
    const copyContext = await readPostCopyContext(engine, post);
    return draftPostCopy(postCopyResponses(getApiKey("OPENAI_API_KEY") ?? undefined), copyContext, payload.request as PostCopyRequest, context.signal);
  });
  registerJobHandler("post_metrics", async (payload, context) => withNotebookMutation(`post-metrics:${payload.postCellId}`, () => refreshPostMetrics(engine, String(payload.postCellId), { signal: context.signal })));
}
