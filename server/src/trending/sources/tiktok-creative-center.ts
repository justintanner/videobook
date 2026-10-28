import type { TiktokCreativeCenterOptions } from "@apicity/tiktok-creative-center";
import { z } from "zod";
import { createTiktokCreativeCenter } from "../../usage-providers.js";
import type { TrendingSource } from "../sources.js";
import type { SourceHealth } from "../types.js";

const count = z.number().nonnegative();
const timestamp = z.number().nonnegative().refine((value) => Number.isFinite(new Date(value * 1000).getTime()));
const base = z.object({ StatusCode: z.literal(0) });
const overviewSchema = z.object({ BaseResp: base, lastWeeklyEndTimestamp: timestamp });
const listSchema = z.object({
  BaseResp: base,
  entityInfos: z.array(z.object({
    itemInfo: z.object({ itemID: z.string().regex(/^\d+$/), title: z.string().optional(), createTime: timestamp, authorID: z.string().optional() }),
    itemMetrics: z.object({ videoViews: count, videoViewsLifeTime: count }),
    itemAuthorInfo: z.object({ handlerName: z.string().min(1), nickName: z.string().optional() }),
    itemAuthorMetrics: z.object({ followers: count.optional() }).optional(),
  })).optional(),
});

export function tiktokCreativeCenterSource(options: TiktokCreativeCenterOptions & { now?: () => number } = {}): TrendingSource {
  const now = options.now ?? Date.now;
  const provider = createTiktokCreativeCenter(options).ads.creativeOne.report;
  let health: SourceHealth = {};
  return {
    id: "tiktok-creative-center",
    health: () => health,
    async sample(input, context) {
      const previous = context.previousHealth ?? {};
      try {
        const overview = overviewSchema.parse(await provider.getTopContentsOverview(context.signal));
        const request = {
          countryCode: input.country.toUpperCase(), periodDimension: 3 as const, orderByMetric: 1 as const,
          periodEndTimestamp: overview.lastWeeklyEndTimestamp, page: 1, limit: Math.max(20, input.limit), contentLabelIDs: "",
        };
        const all = listSchema.parse(await provider.creativeCenterGetTopContentsList({ ...request, organicOnly: false }, context.signal));
        const organic = listSchema.parse(await provider.creativeCenterGetTopContentsList({ ...request, organicOnly: true }, context.signal));
        const organicIds = new Set(organic.entityInfos?.map((row) => row.itemInfo.itemID));
        const capturedAt = new Date(overview.lastWeeklyEndTimestamp * 1000).toISOString();
        health = { lastOk: new Date(now()).toISOString(), lastCapturedAt: capturedAt };
        return {
          capturedAt,
          sightings: (all.entityInfos ?? []).map((row, index) => ({
            platform: "tiktok", videoId: row.itemInfo.itemID,
            url: `https://www.tiktok.com/@${encodeURIComponent(row.itemAuthorInfo.handlerName)}/video/${row.itemInfo.itemID}`,
            author: { handle: row.itemAuthorInfo.handlerName, nickname: row.itemAuthorInfo.nickName,
              id: row.itemInfo.authorID, followers: row.itemAuthorMetrics?.followers },
            caption: row.itemInfo.title ?? "", originRegion: input.country.toUpperCase(),
            createdAt: new Date(row.itemInfo.createTime * 1000).toISOString(),
            metrics: { views: row.itemMetrics.videoViewsLifeTime, likes: 0 }, windowViews: row.itemMetrics.videoViews,
            isAd: !organicIds.has(row.itemInfo.itemID), fallback: true,
            source: "tiktok-creative-center", sourceRank: index + 1, observedAt: capturedAt,
          })),
        };
      } catch (error) {
        context.signal.throwIfAborted();
        const reason = error instanceof Error ? error.message : String(error);
        health = { ...previous, lastError: `TikTok Creative Center disabled for this sample: ${error instanceof z.ZodError ? "response schema mismatch: " : ""}${reason}` };
        return;
      }
    },
  };
}
