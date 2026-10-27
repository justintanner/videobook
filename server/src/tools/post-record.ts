import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Engine } from "videobook-engine";
import type { ToolDef } from "./tool-def.js";
import { queue } from "../queue.js";
import { getPost, listPosts, migrateLegacyPosts, readPostRuntime, updatePost } from "../posts/post-store.js";
import { POST_METRIC_NAMES, POST_PLATFORMS, POST_STATUSES } from "../posts/post-contract.js";
import type { PostMetrics, PostPlatform, PostStatus, PostView } from "../posts/post-contract.js";
import { recordPostMetrics } from "../posts/post-metrics.js";
import { postAnalysisTarget } from "../posts/post-copy.js";
import { cancelScheduledPost } from "../scheduled-posts.js";
import { freshPostLanguage } from "../lightning-defaults.js";
import { POST_COPY_LANGUAGES } from "../posts/post-copy-format.js";
import { getApiKey } from "../api-key.js";
import { analyzeVideoJobPayload } from "./analyze-video.js";

const book = { book_id: z.string() };
const target = { ...book, post_cell_id: z.string().uuid() };
const fields = { platform: z.enum(POST_PLATFORMS).optional(), account: z.string().max(200).optional(), caption: z.string().max(25_000).optional(), credits: z.string().max(10_000).optional(), notes: z.string().max(20_000).optional() };

function define(name: string, description: string, schema: ToolDef["schema"], handler: (args: Record<string, unknown>) => Promise<unknown>, scope: "book" | "global" = "book"): ToolDef {
  return { name, description, schema, scope, handler: async (args) => {
    try { return { content: [{ type: "text", text: JSON.stringify(await handler(args)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
  } };
}

async function draftPostCopyTool(engine: Engine, args: Record<string, unknown>): Promise<unknown> {
  if (!getApiKey("OPENAI_API_KEY")) throw new Error("OPENAI_API_KEY is not set");
  const bookId = String(args.book_id);
  const postCellId = String(args.post_cell_id);
  const post = getPost(engine, postCellId);
  if (!post.definition.source) throw new Error(`${post.address} has no saved source clip. Choose one in the Post panel.`);
  const target = await postAnalysisTarget(engine, post);
  if (target?.analyzable && !target.analyzed) {
    await queue.enqueueAndWait(`post-copy-analysis-${target.assetId}-${randomUUID()}`, await analyzeVideoJobPayload(engine, target.assetId, bookId, "tagging"));
  }
  const platform = (args.platform as PostPlatform | undefined) ?? post.definition.platform;
  const suppliedTags = Array.isArray(args.tags)
    ? args.tags.filter((tag): tag is string => typeof tag === "string")
    : undefined;
  const request = {
    platform,
    language: freshPostLanguage(platform, args.language),
    instruction: typeof args.instruction === "string" ? args.instruction : undefined,
    caption: typeof args.caption === "string" ? args.caption : undefined,
    tags: suppliedTags,
  };
  return queue.enqueueAndWait(`post-copy-${postCellId}-${randomUUID()}`, { type: "post_copy", bookId, postCellId, request });
}

type PostPatch = Parameters<typeof updatePost>[2];

function postPatch(args: Record<string, unknown>): PostPatch {
  const patch: PostPatch = {};
  for (const name of ["account", "caption", "credits", "notes"] as const) if (typeof args[name] === "string") patch[name] = args[name];
  if (args.platform) patch.platform = args.platform as PostPlatform;
  if (args.source_cell_id) patch.sourceCellId = String(args.source_cell_id);
  return patch;
}

async function cancelPostSchedule(engine: Engine, postCellId: string): Promise<void> {
  const runtime = readPostRuntime(engine, postCellId);
  if (runtime.status !== "scheduled" || !runtime.scheduleId) throw new Error("This Post has no scheduled publication to cancel");
  if (!await cancelScheduledPost(runtime.scheduleId)) throw new Error("The scheduled publication already started, so it can no longer be cancelled");
}

async function updatePostTool(engine: Engine, args: Record<string, unknown>): Promise<PostView> {
  const bookId = String(args.book_id);
  const postCellId = String(args.post_cell_id);
  if (args.url !== undefined && args.posted_at === undefined) throw new Error("posted_at is required with url");
  if (args.cancel_schedule === true) await cancelPostSchedule(engine, postCellId);
  const patch = postPatch(args);
  let post = Object.keys(patch).length > 0
    ? await queue.enqueueAndWait<PostView>(`post-update-${postCellId}-${randomUUID()}`, { type: "post_update", bookId, postCellId, patch })
    : getPost(engine, postCellId);
  if (typeof args.url !== "string") return post;
  post = await queue.enqueueAndWait<PostView>(`post-link-${postCellId}-${randomUUID()}`, { type: "post_link", bookId, postCellId, url: args.url, postedAt: String(args.posted_at) });
  if (post.definition.platform === "x") await queue.enqueue(`post-metrics-${post.id}-${randomUUID()}`, { type: "post_metrics", bookId, postCellId: post.id });
  return post;
}

async function recordPostMetricsTool(engine: Engine, args: Record<string, unknown>): Promise<unknown> {
  const postCellId = String(args.post_cell_id);
  if (args.values === undefined) return queue.enqueueAndWait(`post-metrics-${postCellId}-${randomUUID()}`, { type: "post_metrics", bookId: String(args.book_id), postCellId });
  const observedAt = typeof args.observed_at === "string" ? args.observed_at : new Date().toISOString();
  recordPostMetrics(engine, postCellId, { source: "manual", observedAt, values: args.values as PostMetrics, note: args.note as string | undefined });
  return getPost(engine, postCellId);
}

async function listPostsTool(engine: Engine, args: Record<string, unknown>): Promise<{ posts: PostView[] }> {
  await migrateLegacyPosts(engine);
  if (typeof args.post_cell_id === "string") return { posts: [getPost(engine, args.post_cell_id)] };
  const status = args.status as PostStatus | undefined;
  return { posts: listPosts(engine).filter((post) => !status || post.runtime.status === status) };
}

export function postRecordDefs(engine: Engine): ToolDef[] {
  return [
    define("list_posts", "List this book's Posts with their status, frozen source, lineage, delivery receipts, scheduled time and timestamped results. post_cell_id reads one Post; status scheduled lists the X posts waiting to publish.", { ...book, post_cell_id: z.string().uuid().optional(), status: z.enum(POST_STATUSES).optional() }, async (args) => listPostsTool(engine, args)),
    define("update_post", "Edit a Post's draft or notes, attach the real link after posting it by hand (url with posted_at), or cancel its scheduled X post (cancel_schedule). Delivered media, caption and source versions are immutable; post the clip again for a repost.", { ...target, ...fields, source_cell_id: z.string().uuid().optional(), url: z.string().url().optional(), posted_at: z.string().datetime().optional(), cancel_schedule: z.literal(true).optional() }, async (args) => updatePostTool(engine, args)),
    define("draft_post_copy", "Draft a Post's caption and hashtags from its clip's analysis, transcript and prompts (analyzing the clip first when needed) without saving. language defaults to Thai for TikTok and English otherwise; instruction, caption and tags rewrite an existing draft.", { ...target, language: z.enum(POST_COPY_LANGUAGES).optional(), platform: z.enum(POST_PLATFORMS).optional(), instruction: z.string().max(1000).optional(), caption: fields.caption, tags: z.array(z.string().max(100)).max(50).optional() }, async (args) => draftPostCopyTool(engine, args)),
    define("record_post_metrics", "Record a performance observation for a published Post: omit values to fetch current X metrics, or pass values for a manual observation (observed_at defaults to now). Omit unavailable metrics; zero means an observed zero.", { ...target, values: z.partialRecord(z.enum(POST_METRIC_NAMES), z.number().int().nonnegative().nullable()).refine((value) => Object.keys(value).length > 0).optional(), observed_at: z.string().datetime().optional(), note: z.string().optional() }, async (args) => recordPostMetricsTool(engine, args)),
  ];
}
