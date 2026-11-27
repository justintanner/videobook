import type { OmkarOptions } from "@apicity/omkar";
import { z } from "zod";
import { getApiKey, isPlaceholderApiKey } from "../../api-key.js";
import { createOmkar } from "../../usage-providers.js";
import type { TrendingSource } from "../sources.js";
import type { Sighting, SourceHealth } from "../types.js";

const count = z.number().nonnegative();
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const videoSchema = z.object({
  id: z.string().min(1),
  link: z.url(),
  type: z.unknown().optional(),
  description: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  language: z.string().optional(),
  created_at: timestamp,
  location_created: z.string().nullable().optional(),
  is_ad: z.boolean(),
  is_ai_generated: z.unknown().optional(),
  cover: z.unknown().optional(),
  video: z.unknown().optional(),
  stats: z.object({
    play_count: count,
    like_count: count,
    comment_count: count.optional(),
    share_count: count.optional(),
    save_count: count.optional(),
  }),
  author: z.object({
    id: z.string().optional(),
    username: z.string().min(1),
    nickname: z.string().optional(),
    is_verified: z.unknown().optional(),
  }),
  author_stats: z.object({ follower_count: count.optional() }).optional(),
  music: z.object({
    id: z.string().optional(),
    title: z.string().optional(),
    author_name: z.string().optional(),
    is_original_sound: z.unknown().optional(),
  }).optional(),
});
const feedSchema = z.object({
  country: z.string().optional(),
  videos: z.array(videoSchema),
});

type FeedVideo = z.infer<typeof videoSchema>;

function optionalDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalKind(value: unknown): "video" | "photo" | undefined {
  return value === "video" || value === "photo" ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function configuredKey(explicit: string | null | undefined): string | null {
  const value = explicit === undefined ? getApiKey("OMKAR_API_KEY") : explicit;
  if (!value || isPlaceholderApiKey(value)) return null;
  return value;
}

function exploreRequested(options: Record<string, unknown> | undefined): boolean {
  return options?.explore === true;
}

function toSighting(video: FeedVideo, index: number, capturedAt: string, country: string, feed: string): Sighting {
  const media = optionalRecord(video.video);
  const durationSeconds = optionalDuration(media?.duration_seconds);
  const coverUrl = optionalUrl(media?.cover) ?? optionalUrl(video.cover);
  const kind = optionalKind(video.type);
  const aiGenerated = optionalBoolean(video.is_ai_generated);
  const verified = optionalBoolean(video.author.is_verified);
  const original = optionalBoolean(video.music?.is_original_sound);
  return {
    platform: "tiktok",
    videoId: video.id,
    url: video.link,
    author: {
      handle: video.author.username,
      id: video.author.id,
      nickname: video.author.nickname,
      followers: video.author_stats?.follower_count,
      ...(verified === undefined ? {} : { verified }),
    },
    caption: video.description ?? video.title ?? "",
    language: video.language,
    originRegion: video.location_created ?? country,
    createdAt: video.created_at,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(coverUrl === undefined ? {} : { coverUrl }),
    ...(kind === undefined ? {} : { kind }),
    ...(aiGenerated === undefined ? {} : { aiGenerated }),
    feed,
    metrics: {
      views: video.stats.play_count,
      likes: video.stats.like_count,
      comments: video.stats.comment_count,
      shares: video.stats.share_count,
      saves: video.stats.save_count,
    },
    music: video.music
      ? {
        id: video.music.id,
        title: video.music.title ?? "",
        author: video.music.author_name,
        ...(original === undefined ? {} : { original }),
      }
      : undefined,
    isAd: video.is_ad,
    source: "omkar",
    sourceRank: index + 1,
    observedAt: capturedAt,
  };
}

export function omkarSource(options: Omit<OmkarOptions, "apiKey"> & { now?: () => number; apiKey?: string | null } = {}): TrendingSource {
  const now = options.now ?? Date.now;
  let health: SourceHealth = {};
  return {
    id: "omkar",
    health: () => health,
    async sample(input, context) {
      const previous = context.previousHealth ?? {};
      const apiKey = configuredKey(options.apiKey);
      if (!apiKey) {
        health = { ...previous, lastError: "Omkar is not configured" };
        return;
      }
      const provider = createOmkar({ apiKey, baseURL: options.baseURL, timeout: options.timeout, fetch: options.fetch });
      try {
        const country = input.country.toUpperCase();
        const trending = feedSchema.safeParse(await provider.feed.trending({ country }, context.signal));
        if (!trending.success) throw new Error(`Omkar response schema mismatch: ${trending.error.message}`);
        const rows: Array<{ video: FeedVideo; feed: string }> = trending.data.videos.map((video) => ({
          video,
          feed: "trending",
        }));
        if (exploreRequested(input.options)) {
          const explored = feedSchema.safeParse(await provider.feed.explore({ country, category: "all" }, context.signal));
          if (!explored.success) throw new Error(`Omkar response schema mismatch: ${explored.error.message}`);
          rows.push(...explored.data.videos.map((video) => ({ video, feed: "explore:all" })));
        }
        const capturedAt = new Date(now()).toISOString();
        const region = trending.data.country ?? country;
        health = { lastOk: capturedAt, lastCapturedAt: capturedAt };
        return {
          capturedAt,
          sightings: rows.map((entry, index) => toSighting(entry.video, index, capturedAt, region, entry.feed)),
        };
      } catch (error) {
        context.signal.throwIfAborted();
        health = { ...previous, lastError: error instanceof Error ? error.message : String(error) };
        return;
      }
    },
  };
}
