import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  collectCandidates,
  defaultBrief,
  organicScore,
  resolveCriteria,
  screenCandidate,
  type ScreenReason,
} from "../../server/src/trending/authenticity.js";
import { endlessSource } from "../../server/src/trending/sources/endless.js";
import type { Sighting } from "../../server/src/trending/types.js";
import { candidate, cutAt, schedule, sighting } from "./trending-fixtures.js";

const fixtures = new URL("./fixtures/trending/", import.meta.url);

describe("trending authenticity", () => {
  describe("criteria and default brief", () => {
    it("returns default criteria and resolves the default brief for the schedule country", () => {
      const resolved = resolveCriteria(schedule);
      expect(resolved).toEqual({
        brief: defaultBrief("TH"),
        minViews: 100_000,
        maxAgeDays: 30,
        maxDurationSeconds: 60,
        judgeLimit: 40,
      });
      expect(defaultBrief("TH")).toContain("in Thailand where");
      expect(defaultBrief("TH")).toContain("filmed outside Thailand.");
      expect(defaultBrief("jp")).toContain("in Japan where");
    });

    it("applies partial overrides without clobbering untouched defaults", () => {
      const custom = resolveCriteria({
        ...schedule,
        criteria: {
          brief: "Only street food carts in Bangkok.",
          minViews: 250_000,
          judgeLimit: 25,
        },
      });
      expect(custom).toEqual({
        brief: "Only street food carts in Bangkok.",
        minViews: 250_000,
        maxAgeDays: 30,
        maxDurationSeconds: 60,
        judgeLimit: 25,
      });
    });
  });

  describe("candidate pool, merge and exclusions", () => {
    it("merges latest snapshot counts and caption, fills sparse fields latest-first, sorts sources and excludes fallback and Creative Center rows", () => {
      const rows: Sighting[] = [
        sighting("v1", {
          source: "omkar",
          observedAt: "2026-10-27T06:00:00.000Z",
          url: "https://www.tiktok.com/@older/video/v1",
          caption: "Older caption",
          author: { handle: "creator", followers: 12_500, verified: true },
          durationSeconds: 18,
          coverUrl: "https://cdn.example/older.webp",
          kind: "video",
          aiGenerated: false,
          music: { title: "original sound", original: true },
          metrics: { views: 200_000, likes: 15_000, shares: 3_000 },
        }),
        sighting("v1", {
          source: "endless",
          observedAt: "2026-10-27T18:00:00.000Z",
          url: "https://www.tiktok.com/@latest/video/v1",
          caption: "Latest caption",
          author: { handle: "creator" },
          coverUrl: "https://cdn.example/latest.webp",
          music: { title: "original sound" },
          metrics: { views: 500_000, likes: 45_000, shares: 9_000, saves: 1_500, comments: 250 },
        }),
        sighting("v1", {
          source: "endless",
          observedAt: "2026-10-27T18:00:00.000Z",
          url: "https://www.tiktok.com/@tie-lower/video/v1",
          caption: "Tie lower views",
          metrics: { views: 300_000, likes: 20_000 },
        }),
        sighting("v1", {
          source: "tiktok-creative-center",
          observedAt: "2026-10-27T23:00:00.000Z",
          caption: "Creative Center should never merge",
          author: { handle: "cc", followers: 999_999 },
          metrics: { views: 5_000_000, likes: 0 },
          isAd: true,
        }),
        sighting("v1", {
          source: "backup-feed",
          fallback: true,
          observedAt: "2026-10-27T23:30:00.000Z",
          caption: "Fallback should never merge",
          aiGenerated: true,
          metrics: { views: 9_000_000, likes: 1 },
        }),
        sighting("only-cc", {
          source: "tiktok-creative-center",
          observedAt: "2026-10-27T20:00:00.000Z",
          metrics: { views: 8_000_000, likes: 0 },
        }),
        sighting("only-fallback", {
          source: "endless",
          fallback: true,
          observedAt: "2026-10-27T20:00:00.000Z",
          metrics: { views: 8_000_000, likes: 500_000 },
        }),
      ];

      const merged = collectCandidates(rows, schedule, { cutAt });
      expect(merged).toHaveLength(1);
      expect(merged[0]).toMatchObject({
        videoId: "v1",
        url: "https://www.tiktok.com/@latest/video/v1",
        caption: "Latest caption",
        observedAt: "2026-10-27T18:00:00.000Z",
        metrics: { views: 500_000, likes: 45_000, shares: 9_000, saves: 1_500, comments: 250 },
        author: { handle: "creator", followers: 12_500, verified: true },
        durationSeconds: 18,
        coverUrl: "https://cdn.example/latest.webp",
        kind: "video",
        aiGenerated: false,
        music: { title: "original sound", original: true },
        sources: ["endless", "omkar"],
      });
      expect(merged[0].isAd).toBeUndefined();
    });

    it("propagates isAd when any merged sighting is flagged as an ad", () => {
      const rows = [
        sighting("ad-early", {
          source: "omkar",
          observedAt: "2026-10-27T06:00:00.000Z",
          isAd: true,
          metrics: { views: 400_000, likes: 40_000 },
        }),
        sighting("ad-early", {
          source: "endless",
          observedAt: "2026-10-27T18:00:00.000Z",
          isAd: false,
          metrics: { views: 500_000, likes: 50_000 },
        }),
      ];
      const [merged] = collectCandidates(rows, schedule, { cutAt });
      expect(merged.isAd).toBe(true);
      expect(screenCandidate(merged, schedule, resolveCriteria(schedule), cutAt)).toBe("promoted");
    });

    it("enforces max(48, windowHours) bounds on observedAt and createdAt and excludes future timestamps", () => {
      const trendingRows = [
        sighting("exact-start", { observedAt: "2026-10-26T00:00:00.000Z" }),
        sighting("too-old", { observedAt: "2026-10-25T23:59:59.999Z" }),
        sighting("exact-cut", { observedAt: cutAt }),
        sighting("after-cut", { observedAt: "2026-10-28T00:00:00.001Z" }),
      ];
      const trendingIds = collectCandidates(trendingRows, { ...schedule, windowHours: 24 }, { cutAt })
        .map((row) => row.videoId);
      expect(trendingIds).toEqual(["exact-start", "exact-cut"]);

      const wideIds = collectCandidates(
        [
          sighting("within-72h", { observedAt: "2026-10-25T00:00:00.000Z" }),
          sighting("outside-72h", { observedAt: "2026-10-24T23:59:59.999Z" }),
        ],
        { ...schedule, windowHours: 72 },
        { cutAt },
      ).map((row) => row.videoId);
      expect(wideIds).toEqual(["within-72h"]);

      const postedRows = [
        sighting("posted-start", { createdAt: "2026-10-26T00:00:00.000Z", observedAt: "2026-10-27T12:00:00.000Z" }),
        sighting("posted-old", { createdAt: "2026-10-25T23:59:59.999Z", observedAt: "2026-10-27T12:00:00.000Z" }),
        sighting("posted-cut", { createdAt: cutAt, observedAt: "2026-10-27T12:00:00.000Z" }),
        sighting("posted-future", { createdAt: "2026-10-28T00:00:00.001Z", observedAt: "2026-10-27T12:00:00.000Z" }),
      ];
      const postedIds = collectCandidates(postedRows, { ...schedule, window: "posted", windowHours: 24 }, { cutAt })
        .map((row) => row.videoId);
      expect(postedIds).toEqual(["posted-start", "posted-cut"]);
    });

    it("removes excluded video ids", () => {
      const rows = [sighting("keep"), sighting("seen-yesterday"), sighting("seen-in-history")];
      const exclude = new Set(["seen-yesterday", "seen-in-history"]);
      const collected = collectCandidates(rows, schedule, { cutAt, exclude });
      expect(collected.map((row) => row.videoId)).toEqual(["keep"]);
    });
  });

  describe("screen rules and precedence", () => {
    const criteria = resolveCriteria(schedule);

    it("passes a clean authentic candidate", () => {
      expect(screenCandidate(candidate("clean"), schedule, criteria, cutAt)).toBeUndefined();
    });

    it("fires each screen reason on its own", () => {
      expect(screenCandidate(candidate("ad", { isAd: true }), schedule, criteria, cutAt)).toBe("promoted");
      expect(
        screenCandidate(candidate("promo-sound", { music: { title: "Promoted Track" } }), schedule, criteria, cutAt),
      ).toBe("promoted");
      expect(
        screenCandidate(candidate("ad-allowed", { isAd: true }), { ...schedule, excludePromoted: false }, criteria, cutAt),
      ).toBeUndefined();

      expect(
        screenCandidate(candidate("paid", { metrics: { views: 1_000_000, likes: 4_999 } }), schedule, criteria, cutAt),
      ).toBe("paid-reach");
      expect(
        screenCandidate(candidate("edge-like", { metrics: { views: 1_000_000, likes: 5_000 } }), schedule, criteria, cutAt),
      ).toBeUndefined();

      expect(screenCandidate(candidate("photo-kind", { kind: "photo" }), schedule, criteria, cutAt)).toBe("photo");
      expect(screenCandidate(candidate("photo-zero", { durationSeconds: 0 }), schedule, criteria, cutAt)).toBe("photo");

      expect(screenCandidate(candidate("ai-clip", { aiGenerated: true }), schedule, criteria, cutAt)).toBe("ai");

      expect(screenCandidate(candidate("too-short", { durationSeconds: 3 }), schedule, criteria, cutAt)).toBe("duration");
      expect(screenCandidate(candidate("too-long", { durationSeconds: 61 }), schedule, criteria, cutAt)).toBe("duration");
      expect(screenCandidate(candidate("min-dur", { durationSeconds: 4 }), schedule, criteria, cutAt)).toBeUndefined();
      expect(screenCandidate(candidate("max-dur", { durationSeconds: 60 }), schedule, criteria, cutAt)).toBeUndefined();
      expect(screenCandidate(candidate("unknown-dur", { durationSeconds: undefined }), schedule, criteria, cutAt)).toBeUndefined();

      expect(
        screenCandidate(candidate("stale", { createdAt: "2026-09-27T23:59:59.000Z" }), schedule, criteria, cutAt),
      ).toBe("stale");
      expect(
        screenCandidate(candidate("exact-age", { createdAt: "2026-09-28T00:00:00.000Z" }), schedule, criteria, cutAt),
      ).toBeUndefined();

      expect(
        screenCandidate(candidate("small", { metrics: { views: 99_999, likes: 10_000 } }), schedule, criteria, cutAt),
      ).toBe("small");
      expect(
        screenCandidate(candidate("exact-views", { metrics: { views: 100_000, likes: 10_000 } }), schedule, criteria, cutAt),
      ).toBeUndefined();

      expect(screenCandidate(candidate("other-country", { originRegion: "US" }), schedule, criteria, cutAt)).toBe("elsewhere");
    });

    it("applies screen reasons in exact priority order when several apply", () => {
      const allBroken = candidate("all-broken", {
        isAd: true,
        metrics: { views: 50_000, likes: 10 },
        kind: "photo",
        aiGenerated: true,
        durationSeconds: 120,
        createdAt: "2026-08-01T00:00:00.000Z",
        originRegion: "US",
      });

      const sequence: Array<[Partial<typeof allBroken>, ScreenReason]> = [
        [{}, "promoted"],
        [{ isAd: false }, "paid-reach"],
        [{ isAd: false, metrics: { views: 50_000, likes: 5_000 } }, "photo"],
        [{ isAd: false, metrics: { views: 50_000, likes: 5_000 }, kind: "video" }, "ai"],
        [{ isAd: false, metrics: { views: 50_000, likes: 5_000 }, kind: "video", aiGenerated: false }, "duration"],
        [
          { isAd: false, metrics: { views: 50_000, likes: 5_000 }, kind: "video", aiGenerated: false, durationSeconds: 20 },
          "stale",
        ],
        [
          {
            isAd: false,
            metrics: { views: 50_000, likes: 5_000 },
            kind: "video",
            aiGenerated: false,
            durationSeconds: 20,
            createdAt: "2026-10-26T00:00:00.000Z",
          },
          "small",
        ],
        [
          {
            isAd: false,
            metrics: { views: 500_000, likes: 50_000 },
            kind: "video",
            aiGenerated: false,
            durationSeconds: 20,
            createdAt: "2026-10-26T00:00:00.000Z",
          },
          "elsewhere",
        ],
      ];

      for (const [patch, expected] of sequence) {
        expect(screenCandidate({ ...allBroken, ...patch }, schedule, criteria, cutAt)).toBe(expected);
      }
    });

    it("only fires elsewhere for a two-letter region other than the schedule country", () => {
      expect(screenCandidate(candidate("foreign-upper", { originRegion: "MM" }), schedule, criteria, cutAt)).toBe("elsewhere");
      expect(screenCandidate(candidate("foreign-lower", { originRegion: "jp" }), schedule, criteria, cutAt)).toBe("elsewhere");
      expect(screenCandidate(candidate("same-lower", { originRegion: "th" }), schedule, criteria, cutAt)).toBeUndefined();
      expect(screenCandidate(candidate("slug", { originRegion: "thailand" }), schedule, criteria, cutAt)).toBeUndefined();
      expect(screenCandidate(candidate("other-slug", { originRegion: "united-states" }), schedule, criteria, cutAt)).toBeUndefined();
      expect(screenCandidate(candidate("missing", { originRegion: undefined }), schedule, criteria, cutAt)).toBeUndefined();
    });
  });

  describe("organic score", () => {
    it("renormalises buzz across present counts, returns 0 buzz when none present, and never penalises missing like zero", () => {
      const base = {
        createdAt: "2026-10-27T00:00:00.000Z",
        views: 100_000,
        likes: 10_000,
      };
      const expectedPace = 0.5;

      const noBuzz = organicScore(
        candidate("no-buzz", { createdAt: base.createdAt, metrics: { views: base.views, likes: base.likes } }),
        cutAt,
      );
      expect(noBuzz).toBeCloseTo(0.5 * expectedPace, 6);

      const missingShares = organicScore(
        candidate("missing-shares", {
          createdAt: base.createdAt,
          metrics: { views: base.views, likes: base.likes, saves: 400, comments: 50 },
        }),
        cutAt,
      );
      expect(missingShares).toBeCloseTo(0.5 * expectedPace + 0.5 * 1, 6);

      const zeroShares = organicScore(
        candidate("zero-shares", {
          createdAt: base.createdAt,
          metrics: { views: base.views, likes: base.likes, shares: 0, saves: 400, comments: 50 },
        }),
        cutAt,
      );
      expect(zeroShares).toBeCloseTo(0.5 * expectedPace + 0.5 * 0.4, 6);
      expect(missingShares).toBeGreaterThan(zeroShares);

      const sharesAndComments = organicScore(
        candidate("shares-comments", {
          createdAt: base.createdAt,
          metrics: { views: base.views, likes: base.likes, shares: 1_000, comments: 50 },
        }),
        cutAt,
      );
      const expectedRenormBuzz = (0.6 * 0.5 + 0.15 * 1) / (0.6 + 0.15);
      expect(sharesAndComments).toBeCloseTo(0.5 * expectedPace + 0.5 * expectedRenormBuzz, 6);
    });

    it("applies the half-day age floor for a clip posted minutes before the cut", () => {
      const metrics = { views: 50_000, likes: 5_000, shares: 1_000, saves: 200, comments: 25 };
      const fiveMinutesOld = organicScore(
        candidate("fresh", { createdAt: "2026-10-27T23:55:00.000Z", metrics }),
        cutAt,
      );
      const halfDayOld = organicScore(
        candidate("half-day", { createdAt: "2026-10-27T12:00:00.000Z", metrics }),
        cutAt,
      );
      expect(fiveMinutesOld).toBeCloseTo(halfDayOld, 10);
      expect(fiveMinutesOld).toBeCloseTo(0.5 * 0.5 + 0.5 * 1, 6);
    });
  });

  describe("golden clips and recorded feed", () => {
    it("passes all seven known-good clips three days after posting, and marks the oldest stale with Loy Krathong cleanup highest on 2026-11-27", async () => {
      const clips = JSON.parse(await readFile(new URL("known-good-clips.json", fixtures), "utf8")) as Sighting[];
      expect(clips).toHaveLength(7);
      const criteria = resolveCriteria(schedule);

      for (const clip of clips) {
        const threeDaysCut = new Date(Date.parse(clip.createdAt) + 3 * 86_400_000).toISOString();
        const [collected] = collectCandidates([{ ...clip, observedAt: threeDaysCut }], schedule, { cutAt: threeDaysCut });
        expect(collected).toBeDefined();
        expect(screenCandidate(collected, schedule, criteria, threeDaysCut)).toBeUndefined();
      }

      const novCut = "2026-11-27T06:00:00Z";
      const candidates = collectCandidates(clips, schedule, { cutAt: novCut });
      expect(candidates).toHaveLength(7);

      const reasons = new Map(candidates.map((row) => [row.videoId, screenCandidate(row, schedule, criteria, novCut)]));
      expect(reasons.get("7665304419675835666")).toBe("stale");
      expect(reasons.get("7680415278987070728")).toBe("stale");
      expect(reasons.get("7691710204576058645")).toBe("stale");
      expect(reasons.get("7711791825853418760")).toBeUndefined();
      expect(reasons.get("7709741807860534535")).toBeUndefined();
      expect(reasons.get("7708329034639248647")).toBeUndefined();
      expect(reasons.get("known-good-red-light")).toBeUndefined();

      const scored = candidates
        .filter((row) => reasons.get(row.videoId) === undefined)
        .map((row) => ({ videoId: row.videoId, score: organicScore(row, novCut) }))
        .sort((left, right) => right.score - left.score);
      expect(scored[0].videoId).toBe("7711791825853418760");
    });

    it("screens the recorded Endless Thailand feed so no sub-0.5% like-rate row survives and drops known paid-reach and duration rows", async () => {
      const raw = await readFile(new URL("recorded-endless-th-covers.json", fixtures), "utf8");
      const source = endlessSource({
        fetch: async () => new Response(raw, { status: 200, headers: { "content-type": "application/json" } }),
      });
      const snapshot = await source.sample(
        { country: "TH", window: "trending", limit: 30 },
        { signal: new AbortController().signal },
      );
      expect(snapshot?.sightings).toHaveLength(30);

      const feedCut = snapshot!.capturedAt;
      const criteria = resolveCriteria(schedule);
      const candidates = collectCandidates(snapshot!.sightings, schedule, { cutAt: feedCut });
      expect(candidates).toHaveLength(30);

      const byId = new Map(candidates.map((row) => [row.videoId, screenCandidate(row, schedule, criteria, feedCut)]));
      const survivors = candidates.filter((row) => byId.get(row.videoId) === undefined);

      expect(survivors.length).toBeGreaterThan(0);
      for (const row of survivors) {
        expect(row.metrics.likes / row.metrics.views).toBeGreaterThanOrEqual(0.005);
      }

      expect(byId.get("7710192299824942354")).toBe("paid-reach");
      expect(byId.get("7693436934781144338")).toBe("paid-reach");
      expect(byId.get("7709464769236962612")).toBe("duration");
      expect(byId.get("7712345733130767623")).toBe("duration");
      expect(byId.get("7712100701630991634")).toBe("photo");
      expect(byId.get("7699876919000468757")).toBe("stale");
    });
  });
});
