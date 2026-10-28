import type { Sighting, TrendingSchedule } from "../../server/src/trending/types.js";

export const cutAt = "2026-10-28T00:00:00.000Z";
export const schedule: TrendingSchedule = {
  scheduleId: "th-daily", platform: "tiktok", country: "TH", timezone: "Asia/Bangkok",
  cutoffLocalTime: "07:00", samplesPerDay: 4, windowHours: 24, topN: 10,
  window: "trending", excludePromoted: true, ranking: "views",
  sources: [{ id: "endless" }, { id: "tiktok-creative-center" }],
  downstream: { transcribe: false, translateTo: [], analyze: false },
  substituteFailures: false, retentionDays: 30, enabled: true, createdAt: cutAt,
};

export function sighting(videoId: string, patch: Partial<Sighting> = {}): Sighting {
  return {
    platform: "tiktok", videoId, url: `https://www.tiktok.com/@author/video/${videoId}`,
    author: { handle: "author" }, caption: "A video", createdAt: "2026-10-26T00:00:00.000Z",
    metrics: { views: 100, likes: 10 }, source: "endless", sourceRank: 1,
    observedAt: "2026-10-27T12:00:00.000Z", ...patch,
  };
}
