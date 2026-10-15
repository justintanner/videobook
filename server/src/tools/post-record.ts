import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Engine } from "videobook-engine";
import type { ToolDef } from "./tool-def.js";
import { queue } from "../queue.js";
import { getPost, listPosts, migrateLegacyPosts, updatePost } from "../posts/post-store.js";
import { POST_METRIC_NAMES, POST_PLATFORMS } from "../posts/post-contract.js";
import type { PostMetrics, PostPlatform, PostView } from "../posts/post-contract.js";
import { recordPostMetrics } from "../posts/post-metrics.js";
import { dropboxStatus, startDropboxConnect } from "../posts/dropbox-auth.js";

const book = { book_id: z.string() };
const target = { ...book, post_cell_id: z.string().uuid() };
const fields = { platform: z.enum(POST_PLATFORMS).optional(), account: z.string().max(200).optional(), caption: z.string().max(25_000).optional(), credits: z.string().max(10_000).optional(), notes: z.string().max(20_000).optional() };

function define(name: string, description: string, schema: ToolDef["schema"], handler: (args: Record<string, unknown>) => Promise<unknown>, scope: "book" | "global" = "book"): ToolDef {
  return { name, description, schema, scope, handler: async (args) => {
    try { return { content: [{ type: "text", text: JSON.stringify(await handler(args)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
  } };
}

export function postRecordDefs(engine: Engine): ToolDef[] {
  return [
    define("create_post", "Create a Post cell to track one publication. Freezes the selected source clip and its upstream idea/prompt lineage; place the cell beside the source.", { ...book, notebook_id: z.string().uuid(), source_cell_id: z.string().uuid().optional(), ...fields }, async (args) => queue.enqueueAndWait(`post-create-${randomUUID()}`, { type: "post_create", bookId: String(args.book_id), args: { notebookId: String(args.notebook_id), sourceCellId: args.source_cell_id as string | undefined, platform: args.platform as PostPlatform | undefined, caption: args.caption as string | undefined, credits: args.credits as string | undefined, account: args.account as string | undefined, notes: args.notes as string | undefined } })),
    define("update_post", "Edit a Post draft or its notes. Delivered media, caption and source versions are immutable; create another Post for a repost.", { ...target, ...fields, source_cell_id: z.string().uuid().optional() }, async (args) => {
      const patch: Parameters<typeof updatePost>[2] = {};
      for (const name of ["account", "caption", "credits", "notes"] as const) if (typeof args[name] === "string") patch[name] = args[name];
      if (args.platform) patch.platform = args.platform as PostPlatform;
      if (args.source_cell_id) patch.sourceCellId = String(args.source_cell_id);
      return queue.enqueueAndWait(`post-update-${args.post_cell_id}-${randomUUID()}`, { type: "post_update", bookId: String(args.book_id), postCellId: String(args.post_cell_id), patch });
    }),
    define("get_post", "Read a Post with its frozen source, lineage, publication receipt and timestamped results.", target, async (args) => { await migrateLegacyPosts(engine); return getPost(engine, String(args.post_cell_id)); }),
    define("list_posts", "List this book's publications and performance observations for comparison.", book, async () => { await migrateLegacyPosts(engine); return { posts: listPosts(engine) }; }),
    define("link_post", "Attach the actual URL and publication time after manually posting. Freezes media and caption; duplicate publication URLs are rejected.", { ...target, url: z.string().url(), posted_at: z.string().datetime() }, async (args) => {
      const post = await queue.enqueueAndWait(`post-link-${args.post_cell_id}-${randomUUID()}`, { type: "post_link", bookId: String(args.book_id), postCellId: String(args.post_cell_id), url: String(args.url), postedAt: String(args.posted_at) }) as PostView;
      if (post.definition.platform === "x") await queue.enqueue(`post-metrics-${post.id}-${randomUUID()}`, { type: "post_metrics", bookId: String(args.book_id), postCellId: post.id });
      return post;
    }),
    define("upload_post_to_dropbox", "Upload the frozen Post media and caption.txt to a private Dropbox folder. Interrupted uploads resume without replacing unrelated files.", { ...target, folder: z.string().optional() }, async (args) => queue.enqueueAndWait(`post-dropbox-${args.post_cell_id}-${randomUUID()}`, { type: "post_dropbox", bookId: String(args.book_id), postCellId: String(args.post_cell_id), folder: args.folder })),
    define("refresh_post_metrics", "Fetch a current X metrics observation. Non-X publications use record_post_metrics. Unknown values remain unknown.", target, async (args) => queue.enqueueAndWait(`post-metrics-${args.post_cell_id}-${randomUUID()}`, { type: "post_metrics", bookId: String(args.book_id), postCellId: String(args.post_cell_id) })),
    define("record_post_metrics", "Append a manual performance observation with its actual timestamp. Omit unavailable metrics; zero means an observed zero.", { ...target, observed_at: z.string().datetime(), values: z.partialRecord(z.enum(POST_METRIC_NAMES), z.number().int().nonnegative().nullable()).refine((value) => Object.keys(value).length > 0), note: z.string().optional() }, async (args) => {
      recordPostMetrics(engine, String(args.post_cell_id), { source: "manual", observedAt: String(args.observed_at), values: args.values as PostMetrics, note: args.note as string | undefined });
      return getPost(engine, String(args.post_cell_id));
    }),
    define("dropbox_connect_start", "Connect Dropbox with offline OAuth access; returns an authorization URL. Credentials stay in application state.", {}, () => startDropboxConnect(), "global"),
    define("dropbox_connect_status", "Read Dropbox connection status without exposing credentials.", {}, () => dropboxStatus(), "global"),
  ];
}
