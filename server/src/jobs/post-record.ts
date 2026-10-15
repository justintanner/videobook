import { createPost, linkPost, updatePost } from "../posts/post-store.js";
import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import { uploadPostToDropbox } from "../posts/dropbox-upload.js";
import { refreshPostMetrics } from "../posts/post-metrics.js";

export function registerPostRecordJobs(engine: Engine): void {
  registerJobHandler("post_create", async (payload) => createPost(engine, payload.args as Parameters<typeof createPost>[1]));
  registerJobHandler("post_update", async (payload) => withNotebookMutation(`post:${payload.postCellId}`, () => updatePost(engine, String(payload.postCellId), payload.patch as Parameters<typeof updatePost>[2])));
  registerJobHandler("post_link", async (payload) => withNotebookMutation(`post:${payload.postCellId}`, () => linkPost(engine, String(payload.postCellId), String(payload.url), String(payload.postedAt))));
  registerJobHandler("post_dropbox", async (payload, context) => withNotebookMutation(`post:${payload.postCellId}`, () => uploadPostToDropbox(engine, String(payload.postCellId), { folder: typeof payload.folder === "string" ? payload.folder : undefined, signal: context.signal })));
  registerJobHandler("post_metrics", async (payload, context) => withNotebookMutation(`post-metrics:${payload.postCellId}`, () => refreshPostMetrics(engine, String(payload.postCellId), { signal: context.signal })));
}
