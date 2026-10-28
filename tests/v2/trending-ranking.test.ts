import { describe, expect, it } from "vitest";
import { rankVideos } from "../../server/src/trending/ranking.js";
import { cutAt, schedule, sighting } from "./trending-fixtures.js";

const ids = (rows: ReturnType<typeof rankVideos>): string[] => rows.map((row) => row.videoId);

describe("trending ranking", () => {
  it("includes both window edges and excludes future and expired observations", () => {
    const rows = [
      sighting("start", { observedAt: "2026-10-27T00:00:00Z" }),
      sighting("end", { observedAt: cutAt }),
      sighting("future", { observedAt: "2026-10-28T00:00:00.001Z" }),
      sighting("expired", { observedAt: "2026-10-25T23:59:59.999Z" }),
    ];
    expect(ids(rankVideos(rows, schedule, { cutAt }))).toEqual(["end", "start"]);
    expect(rows[0].sourceRank).toBe(1);
  });

  it("uses posted dates instead of sightings in posted mode", () => {
    const rows = [sighting("old"), sighting("new", { createdAt: cutAt }), sighting("future", { createdAt: "2026-10-29T00:00:00Z" })];
    expect(ids(rankVideos(rows, { ...schedule, window: "posted", topN: 1 }, { cutAt }))).toEqual(["new"]);
  });

  it("excludes promoted IDs across sources and accepts organic Creative Center rows", () => {
    const rows = [
      sighting("ad", { isAd: true }), sighting("ad", { source: "second" }),
      sighting("music", { music: { title: "Promoted audio" } }),
      sighting("sponsored", { source: "tiktok-creative-center" }),
      sighting("organic", { source: "tiktok-creative-center" }), sighting("normal"),
    ];
    const options = { cutAt, organicVideoIds: new Set(["organic"]) };
    expect(ids(rankVideos(rows, schedule, options))).toEqual(["normal", "organic"]);
    expect(rankVideos(rows, { ...schedule, excludePromoted: false }, options)).toHaveLength(5);
  });

  it("deduplicates with maximum views and unique sources, then breaks view ties", () => {
    const rows = [
      sighting("popular", { metrics: { views: 1000, likes: 0 } }),
      sighting("agreement"), sighting("agreement", { source: "second", metrics: { views: 5, likes: 0 } }),
      sighting("agreement"), sighting("liked", { metrics: { views: 100, likes: 20 } }),
      sighting("early", { createdAt: "2026-10-01T00:00:00Z" }), sighting("late"),
    ];
    const ranked = rankVideos(rows, schedule, { cutAt });
    expect(ids(ranked)).toEqual(["popular", "agreement", "liked", "early", "late"]);
    expect(ranked[1].sources).toEqual(["endless", "second"]);
    expect(ranked[1].metrics.views).toBe(100);
    expect(ranked.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("uses per-source Borda order without counting repeated sightings as votes", () => {
    const rows = [
      sighting("a", { sourceRank: 1 }), sighting("a", { sourceRank: 1 }),
      sighting("b", { sourceRank: 2, metrics: { views: 500, likes: 0 } }),
      sighting("b", { source: "second", sourceRank: 1, metrics: { views: 500, likes: 0 } }),
      sighting("a", { source: "second", sourceRank: 2 }),
    ];
    expect(ids(rankVideos(rows, { ...schedule, ranking: "consensus" }, { cutAt }))).toEqual(["b", "a"]);
    expect(ids(rankVideos([...rows, sighting("a", { source: "third" })], { ...schedule, ranking: "consensus" }, { cutAt }))).toEqual(["a", "b"]);
  });

  it("fills gaps from 48 hours, then flags fallback rows, without duplicates", () => {
    const rows = [sighting("recent"), sighting("wide", { observedAt: "2026-10-26T00:00:00Z", metrics: { views: 9999, likes: 0 } })];
    const fallback = [sighting("recent"), sighting("weekly", { observedAt: "2026-10-20T00:00:00Z" }), sighting("ad", { isAd: true })];
    const ranked = rankVideos(rows, schedule, { cutAt, fallback });
    expect(ids(ranked)).toEqual(["recent", "wide", "weekly"]);
    expect(ranked.map((row) => row.fallback)).toEqual([false, false, true]);
    expect(ids(rankVideos(rows, { ...schedule, topN: 1 }, { cutAt, fallback }))).toEqual(["recent"]);
    expect(rankVideos([], schedule, { cutAt })).toEqual([]);
  });
});
