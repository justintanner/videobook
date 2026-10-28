import type { EndlessOptions, EndlessTikTokTrendsRegion } from "@apicity/endless";
import { z } from "zod";
import { createEndless } from "../../usage-providers.js";
import type { TrendingSource } from "../sources.js";
import type { SourceHealth } from "../types.js";

const regions: Record<string, EndlessTikTokTrendsRegion> = {
  AR: "argentina", BR: "brazil", CA: "canada", CL: "chile", CO: "colombia",
  DO: "dominican-republic", EG: "egypt", ID: "indonesia", JP: "japan", MY: "malaysia",
  MX: "mexico", PE: "peru", PH: "philippines", SA: "saudi-arabia", TH: "thailand",
  TR: "turkey", GB: "united-kingdom", US: "united-states", VE: "venezuela", VN: "vietnam",
};
const count = z.number().nonnegative();
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const snapshotSchema = z.object({
  region: z.string(), captured_at: timestamp,
  videos: z.array(z.object({
    id: z.string().min(1), url: z.url(), created_at: timestamp,
    text: z.string().optional(), region: z.string().optional(), play_count: count, like_count: count.optional(),
    comment_count: count.optional(), share_count: count.optional(), save_count: count.optional(),
    author: z.object({ id: z.string().optional(), username: z.string().optional(), nickname: z.string().optional() }).optional(),
    music: z.object({ id: z.string().optional(), title: z.string().optional(), author: z.string().optional() }).optional(),
  })),
  longest: z.array(z.unknown()), sounds: z.array(z.unknown()), hashtags: z.array(z.unknown()),
});

function headerDelay(value: string | null, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - now) || 0;
}

export function endlessSource(options: EndlessOptions & { now?: () => number } = {}): TrendingSource {
  const now = options.now ?? Date.now;
  let health: SourceHealth = {};
  let nextRequest = 0;
  let failures = 0;
  const provider = createEndless({ ...options, fetch: async (input, init) => {
    const response = await (options.fetch ?? globalThis.fetch)(input, init);
    const at = now();
    const retry = headerDelay(response.headers.get("retry-after"), at);
    const remaining = response.headers.get("ratelimit-remaining");
    const reset = headerDelay(response.headers.get("ratelimit-reset"), at);
    if (response.status === 429 || response.status >= 500) {
      failures += 1;
      nextRequest = at + Math.max(retry, reset, Math.min(3_600_000, 60_000 * 2 ** Math.min(failures - 1, 6)));
    } else if (response.ok) {
      failures = 0;
      nextRequest = remaining !== null && Number(remaining) === 0 ? at + Math.max(reset, retry, 60_000) : 0;
    }
    return response;
  } });
  return {
    id: "endless",
    health: () => health,
    async sample(input, context) {
      const previous = context.previousHealth ?? {};
      const retryAt = Math.max(nextRequest, Date.parse(previous.retryAfter ?? "") || 0);
      health = { ...previous };
      if (now() < retryAt) {
        health.lastError = `Endless rate limit/backoff until ${new Date(retryAt).toISOString()}`;
        health.retryAfter = new Date(retryAt).toISOString();
        return;
      }
      try {
        const region = regions[input.country.toUpperCase()];
        if (!region) throw new Error(`Endless does not support country ${input.country}`);
        const parsed = snapshotSchema.safeParse(await provider.social.tiktokTrends.public({ region }, context.signal));
        if (!parsed.success) throw new Error(`Endless response schema mismatch: ${parsed.error.message}`);
        const data = parsed.data;
        health = { lastOk: new Date(now()).toISOString(), lastCapturedAt: data.captured_at,
          retryAfter: nextRequest > now() ? new Date(nextRequest).toISOString() : undefined };
        return {
          capturedAt: data.captured_at,
          details: { capturedAt: data.captured_at, longest: data.longest, sounds: data.sounds, hashtags: data.hashtags },
          sightings: data.videos.map((video, index) => ({
            platform: "tiktok", videoId: video.id, url: video.url,
            author: { handle: video.author?.username ?? "", id: video.author?.id, nickname: video.author?.nickname },
            caption: video.text ?? "", originRegion: video.region ?? data.region, createdAt: video.created_at,
            metrics: { views: video.play_count, likes: video.like_count ?? 0, comments: video.comment_count, shares: video.share_count, saves: video.save_count },
            music: video.music ? { ...video.music, title: video.music.title ?? "" } : undefined,
            isAd: /promoted/i.test(video.music?.title ?? ""), source: "endless", sourceRank: index + 1, observedAt: data.captured_at,
          })),
        };
      } catch (error) {
        context.signal.throwIfAborted();
        health = { ...previous, lastError: error instanceof Error ? error.message : String(error),
          retryAfter: nextRequest > now() ? new Date(nextRequest).toISOString() : undefined };
        return;
      }
    },
  };
}
