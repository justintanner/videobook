import { createX, XError } from "@apicity/x";
import type { XProvider } from "@apicity/x";
import type { Engine } from "videobook-engine";
import { v7 as uuidv7 } from "uuid";
import { getValidAccessToken } from "../x/x-tokens.js";
import { listBookEngines, queue } from "../queue.js";
import { getPost, listPosts, patchPostRuntime, readPostRuntime } from "./post-store.js";
import { POST_METRIC_NAMES } from "./post-contract.js";
import type { PostMetricSnapshot, PostMetrics } from "./post-contract.js";

const MILESTONES = [1, 24, 72, 168, 672].map((hours) => hours * 3_600_000);

export function nextPostMetricAt(postedAt: string, observedAt: string): string | null {
  const start = new Date(postedAt).getTime();
  const observed = new Date(observedAt).getTime();
  const next = MILESTONES.map((offset) => start + offset).find((time) => time > observed);
  return next === undefined ? null : new Date(next).toISOString();
}

export function recordPostMetrics(engine: Engine, id: string, snapshot: PostMetricSnapshot): void {
  const post = getPost(engine, id);
  if (!post.runtime.postedAt) throw new Error("Link the published post before recording results");
  const time = new Date(snapshot.observedAt).getTime();
  if (!Number.isFinite(time) || time > Date.now() + 60_000 || time < new Date(post.runtime.postedAt).getTime()) throw new Error("Observation time must be after publication and no later than now");
  for (const name of POST_METRIC_NAMES) {
    const value = snapshot.values[name];
    if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`Invalid ${name}: use a nonnegative whole number or leave it unknown`);
  }
  const runtime = readPostRuntime(engine, id);
  const metrics = [...runtime.metrics, { ...snapshot, id: uuidv7(), observedAt: new Date(time).toISOString() }].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  patchPostRuntime(engine, id, { metrics });
}

export async function refreshPostMetrics(engine: Engine, id: string, options: { x?: XProvider; signal?: AbortSignal } = {}): Promise<PostMetricSnapshot> {
  const post = getPost(engine, id);
  if (post.definition.platform !== "x" || !post.runtime.url || !post.runtime.postedAt) throw new Error("Automatic metrics need a linked X publication");
  const tweetId = post.runtime.url.match(/\/status\/(\d+)/)?.[1];
  if (!tweetId) throw new Error("Invalid X post link");
  try {
    const x = options.x ?? createX({ accessToken: await getValidAccessToken() });
    const young = Date.now() - new Date(post.runtime.postedAt).getTime() < 30 * 86_400_000;
    const lookup = (privateMetrics: boolean) => x.get.v2.tweets(tweetId, {
      "tweet.fields": ["created_at", "author_id", "public_metrics", ...(privateMetrics ? ["non_public_metrics" as const] : [])],
      expansions: ["attachments.media_keys"],
      "media.fields": ["media_key", "type", "public_metrics"],
    }, options.signal);
    let result;
    try {
      result = await lookup(young);
    } catch (error) {
      if (!young || !(error instanceof XError) || ![400, 403].includes(error.status)) throw error;
      result = await lookup(false);
    }
    if (!result.data) throw new Error("X post is unavailable, private or deleted");
    const publicMetrics = result.data.public_metrics ?? {};
    const privateMetrics = result.data.non_public_metrics ?? {};
    const values: PostMetrics = {};
    const mapping = { impressions: "impression_count", likes: "like_count", replies: "reply_count", reposts: "retweet_count", quotes: "quote_count", bookmarks: "bookmark_count" } as const;
    for (const [name, source] of Object.entries(mapping)) {
      const value = publicMetrics[source];
      if (typeof value === "number") values[name as keyof typeof mapping] = value;
    }
    if (typeof privateMetrics.url_link_clicks === "number") values.clicks = privateMetrics.url_link_clicks;
    const media = result.includes?.media?.filter((item) => item.type === "video");
    const views = media?.map((item) => item.public_metrics?.view_count).filter((value): value is number => typeof value === "number");
    const snapshot: PostMetricSnapshot = {
      source: "x", observedAt: new Date().toISOString(), values,
      ...(views?.length ? { mediaViews: views.reduce((sum, count) => sum + count, 0) } : {}),
      note: "X video views belong to the media and may include other posts. Missing metrics are unknown.",
    };
    recordPostMetrics(engine, id, snapshot);
    patchPostRuntime(engine, id, { nextMetricAt: nextPostMetricAt(post.runtime.postedAt, snapshot.observedAt), metricsError: null, metricsPaused: false });
    return snapshot;
  } catch (error) {
    const paused = (error instanceof XError && [401, 403, 404].includes(error.status))
      || (error instanceof Error && /access token|token expired|unavailable, private or deleted/i.test(error.message));
    patchPostRuntime(engine, id, {
      metricsError: error instanceof XError ? `X metrics unavailable (${error.status}). Reconnect X or check the post link.` : error instanceof Error ? error.message : "Metrics unavailable",
      metricsPaused: paused,
      nextMetricAt: paused ? null : new Date(Date.now() + (error instanceof XError && error.status === 429 ? 15 : 5) * 60_000).toISOString(),
    });
    throw error;
  }
}

let timer: NodeJS.Timeout | null = null;
let polling = false;

async function collectDuePostMetrics(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    for (const engine of await listBookEngines()) {
      for (const post of listPosts(engine)) {
        if (post.definition.platform !== "x" || !post.runtime.url || !post.runtime.nextMetricAt || post.runtime.metricsPaused || new Date(post.runtime.nextMetricAt).getTime() > Date.now()) continue;
        await queue.enqueue(`post-metrics-${post.id}-${new Date(post.runtime.nextMetricAt).getTime()}`, { type: "post_metrics", bookId: engine.book.get().bookId, postCellId: post.id });
      }
    }
  } finally {
    polling = false;
  }
}

export function startPostMetricsScheduler(): void {
  if (timer) return;
  timer = setInterval(() => { void collectDuePostMetrics().catch(() => undefined); }, 60_000);
  timer.unref();
  void collectDuePostMetrics().catch(() => undefined);
}

export function stopPostMetricsScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
