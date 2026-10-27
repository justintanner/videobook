import type { Engine } from "videobook-engine";
import { freezePostOutbound, getPost, patchPostRuntime, savePostDraft } from "./post-store.js";
import { postDownloadLinks } from "./post-folder.js";
import type { PostDownload } from "./post-folder.js";
import type { PostPlatform, PostStatus, PostView } from "./post-contract.js";

const BLOCKING_STATUSES: ReadonlySet<PostStatus> = new Set(["posting", "needs_reconciliation", "scheduled"]);

export async function preparePostDownload(engine: Engine, id: string, draft: { caption?: string; platform?: PostPlatform } = {}): Promise<{ post: PostView; download: PostDownload }> {
  if (BLOCKING_STATUSES.has(getPost(engine, id).runtime.status)) throw new Error("Resolve or cancel the current publication before downloading");
  const post = await savePostDraft(engine, id, draft);
  if (!post.definition.source) throw new Error(`${post.address} has no saved source clip. Choose one in the Post panel.`);
  const outbound = await freezePostOutbound(engine, id);
  patchPostRuntime(engine, id, { download: { completedAt: new Date().toISOString() }, ...(post.runtime.url ? {} : { status: "ready", error: null }) });
  const delivered = getPost(engine, id);
  const book = engine.book.get();
  return { post: delivered, download: postDownloadLinks({ bookId: book.bookId, name: book.name }, delivered, outbound) };
}
