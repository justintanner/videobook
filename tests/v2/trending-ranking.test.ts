import { describe, expect, it } from "vitest";
import {
  prepareAuthenticCandidates,
  rankAuthentic,
  rankVideos,
  type ScoredCandidate,
} from "../../server/src/trending/ranking.js";
import type { Sighting, TrendingSchedule, TrendingVerdict } from "../../server/src/trending/types.js";
import { candidate, cutAt, schedule, sighting } from "./trending-fixtures.js";

const ids = (rows: ReturnType<typeof rankVideos>): string[] => rows.map((row) => row.videoId);
const authenticSchedule: TrendingSchedule = { ...schedule, ranking: "authentic" };

function scored(
  videoId: string,
  organic: number,
  patch: Partial<Omit<ScoredCandidate, "organic">> = {},
): ScoredCandidate {
  return {
    ...candidate(videoId, {
      coverUrl: `https://cdn.example/${videoId}.webp`,
      ...patch,
    }),
    organic,
  };
}

function verdict(fit: number, patch: Partial<TrendingVerdict> = {}): TrendingVerdict {
  return {
    kind: fit >= 6 ? "candid" : "ad",
    fit,
    why: `Fit ${fit} verdict.`,
    cover: true,
    ...patch,
  };
}

function authenticSighting(videoId: string, patch: Partial<Sighting> = {}): Sighting {
  return sighting(videoId, {
    originRegion: "TH",
    durationSeconds: 20,
    kind: "video",
    aiGenerated: false,
    isAd: false,
    coverUrl: `https://cdn.example/${videoId}.webp`,
    metrics: { views: 500_000, likes: 50_000, shares: 10_000, saves: 2_000, comments: 250 },
    ...patch,
  });
}

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

  it("rejects unsupported ranking methods explicitly instead of falling back to consensus", () => {
    const bogus = { ...schedule, ranking: "unknown" as TrendingSchedule["ranking"] };
    expect(() => rankVideos([sighting("a")], bogus, { cutAt })).toThrow("Unsupported ranking method");
  });
});

describe("authentic ranking", () => {
  it("ranks organic-only by organic score, then views, then videoId, with consecutive ranks and topN", () => {
    const pool = [
      scored("tie-b", 0.6, { metrics: { views: 300_000, likes: 30_000 } }),
      scored("tie-a", 0.6, { metrics: { views: 300_000, likes: 30_000 } }),
      scored("tie-high-views", 0.6, { metrics: { views: 800_000, likes: 80_000 } }),
      scored("top", 0.9, { metrics: { views: 200_000, likes: 20_000 } }),
      scored("low", 0.2, { metrics: { views: 900_000, likes: 90_000 } }),
    ];

    const full = rankAuthentic(pool, { ...authenticSchedule, topN: 10 }, new Map());
    expect(full.videos.map((row) => row.videoId)).toEqual(["top", "tie-high-views", "tie-a", "tie-b", "low"]);
    expect(full.videos.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(full.videos.every((row) => row.fallback === false)).toBe(true);
    expect(full.videos.every((row) => !("coverUrl" in row))).toBe(true);
    expect(full.videos[0].authentic).toEqual({ score: 0.9, organic: 0.9 });
    expect(full.funnel).toEqual({ seen: 5, screened: {}, candidates: 5, checked: 0, fit: 0 });

    const capped = rankAuthentic(pool, { ...authenticSchedule, topN: 3 }, new Map());
    expect(capped.videos.map((row) => row.videoId)).toEqual(["top", "tie-high-views", "tie-a"]);
    expect(capped.videos.map((row) => row.rank)).toEqual([1, 2, 3]);

    const short = rankAuthentic([scored("only", 0.5)], { ...authenticSchedule, topN: 5 }, new Map());
    expect(short.videos).toHaveLength(1);
    expect(short.videos[0].rank).toBe(1);

    const empty = rankAuthentic([], authenticSchedule, new Map());
    expect(empty.videos).toEqual([]);
    expect(empty.funnel).toEqual({ seen: 0, screened: {}, candidates: 0, checked: 0, fit: 0 });
  });

  it("ranks fit-led when any verdict exists, requiring fit >= 6 and excluding unjudged clips", () => {
    const pool = [
      scored("fit9-mid", 0.45),
      scored("fit6-high", 0.9),
      scored("fit6-mid", 0.5),
      scored("fit5-rejected", 0.95),
      scored("unjudged", 1.0),
    ];
    const verdicts = new Map<string, TrendingVerdict>([
      ["fit9-mid", verdict(9, { why: "Candid street moment." })],
      ["fit6-high", verdict(6, { why: "Partly fits." })],
      ["fit6-mid", verdict(6, { why: "Also partly fits." })],
      ["fit5-rejected", verdict(5, { kind: "staged", why: "Scripted skit." })],
    ]);

    const result = rankAuthentic(pool, authenticSchedule, verdicts, {
      seen: 9,
      screened: { "paid-reach": 2, stale: 2 },
      checked: 4,
    });
    expect(result.videos.map((row) => row.videoId)).toEqual(["fit9-mid", "fit6-high", "fit6-mid"]);
    expect(result.videos.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(result.videos[0].authentic?.score).toBeCloseTo(0.9 * (0.6 + 0.4 * 0.45), 10);
    expect(result.videos[1].authentic?.score).toBeCloseTo(0.6 * (0.6 + 0.4 * 0.9), 10);
    expect(result.videos[0].authentic?.score).toBeGreaterThan(result.videos[1].authentic!.score);
    expect(result.videos[0].authentic?.verdict).toEqual(verdicts.get("fit9-mid"));
    expect(result.videos.every((row) => row.fallback === false && !("coverUrl" in row))).toBe(true);
    expect(result.funnel).toEqual({
      seen: 9,
      screened: { "paid-reach": 2, stale: 2 },
      candidates: 5,
      checked: 4,
      fit: 3,
    });

    const allRejected = rankAuthentic(
      [scored("a", 0.9), scored("unjudged", 0.95)],
      authenticSchedule,
      new Map([["a", verdict(4)]]),
    );
    expect(allRejected.videos).toEqual([]);
    expect(allRejected.funnel.fit).toBe(0);
  });

  it("ignores Creative Center fallback and never cross-check merges fallback rows", () => {
    const sightings: Sighting[] = [
      authenticSighting("real-clip", {
        source: "endless",
        metrics: { views: 400_000, likes: 40_000, shares: 8_000, saves: 1_600, comments: 200 },
      }),
      sighting("real-clip", {
        source: "tiktok-creative-center",
        fallback: true,
        metrics: { views: 4_000_000, likes: 0 },
      }),
      authenticSighting("flagged-fallback", {
        source: "endless",
        fallback: true,
      }),
    ];
    const ccFallback = [
      authenticSighting("weekly-cc", {
        source: "tiktok-creative-center",
        observedAt: "2026-10-22T00:00:00.000Z",
      }),
      authenticSighting("extra-fallback", {
        source: "endless",
      }),
    ];

    const ranked = rankVideos(sightings, authenticSchedule, { cutAt, fallback: ccFallback });
    expect(ranked.map((row) => row.videoId)).toEqual(["real-clip"]);
    expect(ranked[0].sources).toEqual(["endless"]);
    expect(ranked[0].metrics.likes).toBe(40_000);
    expect(ranked[0].fallback).toBe(false);
    expect("coverUrl" in ranked[0]).toBe(false);
  });

  it("counts seen clips, every screen reason, surviving candidates, and fit >= 6 in the funnel", () => {
    const rows: Sighting[] = [
      authenticSighting("keep-1", { source: "endless", observedAt: "2026-10-27T10:00:00.000Z" }),
      authenticSighting("keep-1", { source: "omkar", observedAt: "2026-10-27T18:00:00.000Z" }),
      authenticSighting("keep-2", {
        metrics: { views: 300_000, likes: 24_000, shares: 4_000, saves: 800, comments: 100 },
      }),
      authenticSighting("keep-3", {
        metrics: { views: 250_000, likes: 18_000, shares: 3_000, saves: 600, comments: 80 },
      }),
      authenticSighting("drop-promoted", { isAd: true }),
      authenticSighting("drop-paid", { metrics: { views: 1_000_000, likes: 1_000 } }),
      authenticSighting("drop-photo", { kind: "photo" }),
      authenticSighting("drop-ai", { aiGenerated: true }),
      authenticSighting("drop-duration", { durationSeconds: 95 }),
      authenticSighting("drop-stale-1", { createdAt: "2026-09-01T00:00:00.000Z" }),
      authenticSighting("drop-stale-2", { createdAt: "2026-09-10T00:00:00.000Z" }),
      authenticSighting("drop-small", { metrics: { views: 50_000, likes: 10_000 } }),
      authenticSighting("drop-elsewhere", { originRegion: "US" }),
    ];

    const prepared = prepareAuthenticCandidates(rows, authenticSchedule, { cutAt });
    expect(prepared.seen).toBe(12);
    expect(prepared.screened).toEqual({
      promoted: 1,
      "paid-reach": 1,
      photo: 1,
      ai: 1,
      duration: 1,
      stale: 2,
      small: 1,
      elsewhere: 1,
    });
    expect(prepared.candidates).toHaveLength(3);

    const verdicts = new Map<string, TrendingVerdict>([
      ["keep-1", verdict(8)],
      ["keep-2", verdict(6)],
      ["keep-3", verdict(5)],
    ]);
    const ranked = rankAuthentic(prepared.candidates, { ...authenticSchedule, topN: 1 }, verdicts, {
      seen: prepared.seen,
      screened: prepared.screened,
      checked: 3,
    });
    expect(ranked.videos).toHaveLength(1);
    expect(ranked.funnel).toEqual({
      seen: 12,
      screened: {
        promoted: 1,
        "paid-reach": 1,
        photo: 1,
        ai: 1,
        duration: 1,
        stale: 2,
        small: 1,
        elsewhere: 1,
      },
      candidates: 3,
      checked: 3,
      fit: 2,
    });
  });

  it("validates topN, windowHours and cutAt before reading sightings or building candidates", () => {
    let sightingsRead = false;
    const poisonedSightings = new Proxy<Sighting[]>([], {
      get(_target, prop) {
        sightingsRead = true;
        throw new Error(`Sightings accessed before validation: ${String(prop)}`);
      },
    });

    expect(() => rankVideos(poisonedSightings, { ...authenticSchedule, topN: 0 }, { cutAt }))
      .toThrow("topN must be between 1 and 63");
    expect(() => rankVideos(poisonedSightings, { ...authenticSchedule, topN: 64 }, { cutAt }))
      .toThrow("topN must be between 1 and 63");
    expect(() => rankVideos(poisonedSightings, { ...authenticSchedule, windowHours: 0 }, { cutAt }))
      .toThrow("Invalid ranking window");
    expect(() => rankVideos(poisonedSightings, authenticSchedule, { cutAt: "not-a-date" }))
      .toThrow("Invalid ranking cutoff");

    expect(() => prepareAuthenticCandidates(poisonedSightings, { ...authenticSchedule, topN: 0 }, { cutAt }))
      .toThrow("topN must be between 1 and 63");
    expect(() => prepareAuthenticCandidates(poisonedSightings, { ...authenticSchedule, windowHours: -1 }, { cutAt }))
      .toThrow("Invalid ranking window");
    expect(() => prepareAuthenticCandidates(poisonedSightings, authenticSchedule, { cutAt: "bad" }))
      .toThrow("Invalid ranking cutoff");

    expect(sightingsRead).toBe(false);

    expect(() => rankAuthentic([], { ...authenticSchedule, topN: 0 })).toThrow("topN must be between 1 and 63");
    expect(() => rankAuthentic([], { ...authenticSchedule, windowHours: 0 })).toThrow("Invalid ranking window");
  });
});
