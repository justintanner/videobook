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
  description: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  language: z.string().optional(),
  created_at: timestamp,
  location_created: z.string().nullable().optional(),
  is_ad: z.boolean(),
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
  }),
  author_stats: z.object({ follower_count: count.optional() }).optional(),
  music: z.object({
    id: z.string().optional(),
    title: z.string().optional(),
    author_name: z.string().optional(),
  }).optional(),
});
const feedSchema = z.object({
  country: z.string().optional(),
  videos: z.array(videoSchema),
});

type FeedVideo = z.infer<typeof videoSchema>;

function configuredKey(explicit: string | null | undefined): string | null {
  const value = explicit === undefined ? getApiKey("OMKAR_API_KEY") : explicit;
  if (!value || isPlaceholderApiKey(value)) return null;
  return value;
}

function exploreRequested(options: Record<string, unknown> | undefined): boolean {
  return options?.explore === true;
}

function toSighting(video: FeedVideo, index: number, capturedAt: string, country: string): Sighting {
  return {
    platform: "tiktok",
    videoId: video.id,
    url: video.link,
    author: {
      handle: video.author.username,
      id: video.author.id,
      nickname: video.author.nickname,
      followers: video.author_stats?.follower_count,
    },
    caption: video.description ?? video.title ?? "",
    language: video.language,
    originRegion: video.location_created ?? country,
    createdAt: video.created_at,
    metrics: {
      views: video.stats.play_count,
      likes: video.stats.like_count,
      comments: video.stats.comment_count,
      shares: video.stats.share_count,
      saves: video.stats.save_count,
    },
    music: video.music ? { id: video.music.id, title: video.music.title ?? "", author: video.music.author_name } : undefined,
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
        let videos = trending.data.videos;
        if (exploreRequested(input.options)) {
          const explored = feedSchema.safeParse(await provider.feed.explore({ country, category: "all" }, context.signal));
          if (!explored.success) throw new Error(`Omkar response schema mismatch: ${explored.error.message}`);
          videos = [...videos, ...explored.data.videos];
        }
        const capturedAt = new Date(now()).toISOString();
        const region = trending.data.country ?? country;
        health = { lastOk: capturedAt, lastCapturedAt: capturedAt };
        return { capturedAt, sightings: videos.map((video, index) => toSighting(video, index, capturedAt, region)) };
      } catch (error) {
        context.signal.throwIfAborted();
        health = { ...previous, lastError: error instanceof Error ? error.message : String(error) };
        return;
      }
    },
  };
}
