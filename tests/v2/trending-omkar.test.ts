import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BookManager } from "../../server/src/book-manager.js";
import { sampleTrending } from "../../server/src/jobs/trending-sample.js";
import { ensureControlBook } from "../../server/src/trending/control-book.js";
import { readLedger } from "../../server/src/trending/ledger.js";
import { testBudget } from "../../server/src/test-budget.js";
import { omkarSource } from "../../server/src/trending/sources/omkar.js";
import { rankVideos } from "../../server/src/trending/ranking.js";
import { cutAt, schedule } from "./trending-fixtures.js";

let server: Server;
let baseURL: string;
let root: string;
let books: BookManager | undefined;
let status: number;
let body: string;
let exploreBody: string;
let home: string | undefined;
let requests: URL[];
const feedResponses = new Map<string, { status?: number; body?: string }>();
const signal = new AbortController().signal;
const input = { country: "TH", window: "trending" as const, limit: 10 };
const capturedAt = cutAt;

function video(id: string, isAd: boolean, views: number, patch: Record<string, unknown> = {}) {
  return {
    id, link: `https://www.tiktok.com/@thai/video/${id}`, description: `caption ${id}`, title: null,
    language: "th", created_at: "2026-10-27T00:00:00.000Z", location_created: "TH", is_ad: isAd,
    stats: { play_count: views, like_count: 10, comment_count: 2, share_count: 3, save_count: 4 },
    author: { id: "author-1", username: "thai", nickname: "Thai" },
    author_stats: { follower_count: 1000 },
    music: { id: "sound-1", title: "song", author_name: "artist" },
    ...patch,
  };
}

const healthy = JSON.stringify({
  country: "TH", video_count: 2,
  videos: [video("7569000000000000001", false, 12000), video("7569000000000000002", true, 999999)],
});
const explored = JSON.stringify({
  country: "TH", video_count: 1, videos: [video("7569000000000000003", false, 800)],
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trending-omkar-"));
  home = process.env.VIDEOBOOK_HOME;
  process.env.VIDEOBOOK_HOME = root;
  delete process.env.OMKAR_API_KEY;
  status = 200;
  body = healthy;
  exploreBody = explored;
  requests = [];
  feedResponses.clear();
  server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    requests.push(url);
    const feed = url.searchParams.get("category") ?? "trending";
    const override = feedResponses.get(feed);
    const code = override?.status ?? status;
    response.writeHead(code, { "content-type": "application/json" });
    if (code !== 200) {
      response.end('{"code":"rate_limited","message":"slow down"}');
      return;
    }
    response.end(override?.body ?? (url.pathname === "/feed/explore" ? exploreBody : body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  baseURL = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await books?.close();
  books = undefined;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (home === undefined) delete process.env.VIDEOBOOK_HOME;
  else process.env.VIDEOBOOK_HOME = home;
  delete process.env.OMKAR_API_KEY;
  await rm(root, { recursive: true, force: true });
});

function source(apiKey: string | null = "omkar-live") {
  return omkarSource({ apiKey, baseURL, now: () => Date.parse(capturedAt) });
}

describe("omkar trending source", () => {
  it("normalizes one Thailand trending sample and excludes is_ad videos", async () => {
    const adapter = source();
    const snapshot = await adapter.sample(input, { signal });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe("/feed/trending");
    expect(requests[0]?.searchParams.get("country")).toBe("TH");
    expect(requests[0]?.hostname).toBe("127.0.0.1");
    expect(snapshot?.capturedAt).toBe(capturedAt);
    expect(snapshot?.sightings).toHaveLength(2);
    expect(snapshot?.sightings[0]).toMatchObject({
      videoId: "7569000000000000001", url: "https://www.tiktok.com/@thai/video/7569000000000000001",
      author: { handle: "thai", id: "author-1", nickname: "Thai", followers: 1000 },
      caption: "caption 7569000000000000001", language: "th", originRegion: "TH",
      createdAt: "2026-10-27T00:00:00.000Z",
      metrics: { views: 12000, likes: 10, comments: 2, shares: 3, saves: 4 },
      isAd: false, source: "omkar", sourceRank: 1, observedAt: capturedAt,
    });
    expect(snapshot?.sightings[1]).toMatchObject({ videoId: "7569000000000000002", isAd: true, sourceRank: 2 });
    const ranked = rankVideos(snapshot?.sightings ?? [], schedule, { cutAt: capturedAt });
    expect(ranked.map((row) => row.videoId)).toEqual(["7569000000000000001"]);
    expect(adapter.health().lastError).toBeUndefined();
  });

  it("reports schema drift as source health and does not throw", async () => {
    body = '{"country":"TH","videos":[{"id":"1"}]}';
    const adapter = source();
    await expect(adapter.sample(input, { signal })).resolves.toBeUndefined();
    expect(adapter.health().lastError).toContain("schema mismatch");
    expect(requests).toHaveLength(1);
  });

  it("makes no request and reports not configured when the key is unset", async () => {
    const adapter = source(null);
    await expect(adapter.sample(input, { signal })).resolves.toBeUndefined();
    expect(adapter.health().lastError).toContain("not configured");
    expect(requests).toHaveLength(0);
    delete process.env.OMKAR_API_KEY;
    const fromEnv = omkarSource({ baseURL, now: () => Date.parse(capturedAt) });
    await expect(fromEnv.sample(input, { signal })).resolves.toBeUndefined();
    expect(fromEnv.health().lastError).toContain("not configured");
    expect(requests).toHaveLength(0);
  });

  it("does not retry a failed trending request", async () => {
    status = 500;
    const adapter = source();
    await expect(adapter.sample(input, { signal })).resolves.toBeUndefined();
    expect(adapter.health().lastError).toContain("Omkar API error 500");
    expect(requests).toHaveLength(1);
  });

  it("adds one Explore sample only when the schedule opts in", async () => {
    const adapter = source();
    const snapshot = await adapter.sample({ ...input, options: { explore: true } }, { signal });
    expect(requests.map((url) => url.pathname)).toEqual(["/feed/trending", "/feed/explore"]);
    expect(requests[1]?.searchParams.get("category")).toBe("all");
    expect(requests[1]?.searchParams.get("country")).toBe("TH");
    expect(snapshot?.sightings.map((row) => [row.videoId, row.sourceRank, row.isAd])).toEqual([
      ["7569000000000000001", 1, false],
      ["7569000000000000002", 2, true],
      ["7569000000000000003", 3, false],
    ]);
    expect(snapshot?.sightings.map((row) => row.feed)).toEqual(["trending", "trending", "explore:all"]);
  });

  it("requests the configured categories in order and ranks each video at its first occurrence", async () => {
    feedResponses.set("animals", { body: JSON.stringify({ videos: [
      video("7569000000000000001", false, 50000), video("4", false, 400),
    ] }) });
    const adapter = source();
    const snapshot = await adapter.sample({ ...input, options: { categories: ["comedy", "animals"] } }, { signal });
    expect(requests.map((url) => [url.pathname, url.searchParams.get("category"), url.searchParams.get("country")])).toEqual([
      ["/feed/trending", null, "TH"], ["/feed/explore", "comedy", "TH"], ["/feed/explore", "animals", "TH"],
    ]);
    expect(snapshot?.sightings.map((row) => [row.videoId, row.feed, row.sourceRank, row.metrics.views])).toEqual([
      ["7569000000000000001", "trending", 1, 12000], ["7569000000000000002", "trending", 2, 999999],
      ["7569000000000000003", "explore:comedy", 3, 800], ["4", "explore:animals", 4, 400],
    ]);
    expect(adapter.health().lastError).toBeUndefined();
  });

  it("keeps successful feeds and reports failed and unknown categories", async () => {
    feedResponses.set("comedy", { status: 500 });
    exploreBody = JSON.stringify({ videos: [] });
    feedResponses.set("animals", { body: explored });
    const adapter = source();
    const snapshot = await adapter.sample({
      ...input, options: { explore: true, categories: ["comedy", "missing-category", "all", "animals"] },
    }, { signal });
    expect(requests.map((url) => url.searchParams.get("category"))).toEqual([null, "all", "comedy", "animals"]);
    expect(snapshot?.sightings.map((row) => row.feed)).toEqual(["trending", "trending", "explore:animals"]);
    expect(adapter.health()).toMatchObject({ lastOk: capturedAt, lastCapturedAt: capturedAt });
    expect(adapter.health().lastError).toContain("explore:comedy: Omkar API error 500");
    expect(adapter.health().lastError).toContain("missing-category");
  });

  it("returns an empty successful Explore feed after trending fails and retains previous health if every feed fails", async () => {
    body = "{}";
    exploreBody = JSON.stringify({ videos: [] });
    const adapter = source();
    const withExplore = { ...input, options: { categories: ["cars"] } };
    await expect(adapter.sample(withExplore, { signal })).resolves.toEqual({ capturedAt, sightings: [] });
    expect(adapter.health()).toMatchObject({ lastOk: capturedAt, lastError: expect.stringContaining("trending: Omkar response schema mismatch") });
    const previousHealth = adapter.health();
    feedResponses.set("cars", { status: 429 });
    await expect(adapter.sample(withExplore, { signal, previousHealth })).resolves.toBeUndefined();
    expect(adapter.health()).toMatchObject({ lastCapturedAt: capturedAt, lastOk: capturedAt });
    expect(adapter.health().lastError).toContain("trending:");
    expect(adapter.health().lastError).toContain("explore:cars: Omkar API error 429");
  });

  it.each(["trending", "comedy", "daily-life", "animals", "cars", "society"])("parses the recorded Thailand %s feed", async (feed) => {
    const recording = await readFile(new URL(`./fixtures/trending/recorded-omkar-th-${feed}.json`, import.meta.url), "utf8");
    body = JSON.stringify({ videos: [] });
    feedResponses.set(feed, { body: recording });
    const adapter = source();
    const categories = feed === "trending" ? [] : [feed];
    const snapshot = await adapter.sample({ ...input, options: { categories } }, { signal });
    expect(adapter.health().lastError).toBeUndefined();
    const videos: Array<{ id: string }> = JSON.parse(recording).videos;
    expect(snapshot?.sightings.map((row) => row.videoId)).toEqual(videos.map((row) => row.id));
    expect(new Set(snapshot?.sightings.map((row) => row.feed))).toEqual(new Set([feed === "trending" ? feed : `explore:${feed}`]));
  });

  it("maps research fields, photo posts, tolerant bad fields, ledger persistence, and keeps views/consensus ranking unchanged", async () => {
    body = JSON.stringify({
      country: "TH",
      video_count: 4,
      videos: [
        video("7569000000000000101", false, 20000, {
          type: "video",
          is_ai_generated: true,
          cover: "https://cdn.example/fallback-101.jpg",
          video: { duration_seconds: 18, cover: "https://cdn.example/video-101.jpg" },
          author: { id: "author-1", username: "verified_creator", nickname: "Verified", is_verified: true },
          music: { id: "sound-1", title: "original sound", author_name: "artist", is_original_sound: true },
        }),
        video("7569000000000000102", false, 15000, {
          type: "photo",
          is_ai_generated: null,
          cover: "https://cdn.example/photo-102.jpg",
          video: null,
          author: { id: "author-2", username: "photo_user", nickname: "Photo", is_verified: false },
          music: { id: "sound-2", title: "pop track", author_name: "band", is_original_sound: false },
        }),
        video("7569000000000000103", false, 10000, {
          type: "carousel",
          is_ai_generated: "yes",
          cover: "not-a-url",
          video: { duration_seconds: "twenty", cover: 123 },
          author: { id: "author-3", username: "bad_types", nickname: "Bad", is_verified: "true" },
          music: { id: "sound-3", title: "song", author_name: "artist", is_original_sound: null },
        }),
        video("7569000000000000104", false, 8000, {
          type: 42,
          is_ai_generated: null,
          cover: null,
          video: "unexpected-string",
          author: { id: "author-4", username: "bad_video_obj", nickname: "BadObj", is_verified: null },
          music: { id: "sound-4", title: "song", author_name: "artist", is_original_sound: 1 },
        }),
      ],
    });
    exploreBody = JSON.stringify({
      country: "TH",
      video_count: 1,
      videos: [
        video("7569000000000000105", false, 18000, {
          type: "video",
          is_ai_generated: false,
          cover: "https://cdn.example/explore-105.jpg",
          video: { duration_seconds: 12, cover: "https://cdn.example/explore-105.jpg" },
          author: { id: "author-5", username: "explorer", nickname: "Explorer", is_verified: false },
          music: { id: "sound-5", title: "orig", author_name: "explorer", is_original_sound: true },
        }),
      ],
    });

    const adapter = source();
    const snapshot = await adapter.sample({ ...input, options: { explore: true } }, { signal });
    expect(snapshot?.sightings).toHaveLength(5);
    expect(snapshot?.sightings[0]).toMatchObject({
      videoId: "7569000000000000101",
      kind: "video",
      aiGenerated: true,
      durationSeconds: 18,
      coverUrl: "https://cdn.example/video-101.jpg",
      feed: "trending",
      author: { handle: "verified_creator", verified: true },
      music: { title: "original sound", original: true },
    });
    expect(snapshot?.sightings[1]).toMatchObject({
      videoId: "7569000000000000102",
      kind: "photo",
      coverUrl: "https://cdn.example/photo-102.jpg",
      feed: "trending",
      author: { handle: "photo_user", verified: false },
      music: { title: "pop track", original: false },
    });
    expect(snapshot?.sightings[1].durationSeconds).toBeUndefined();
    expect(snapshot?.sightings[1].aiGenerated).toBeUndefined();

    for (const malformed of [snapshot?.sightings[2], snapshot?.sightings[3]]) {
      expect(malformed?.kind).toBeUndefined();
      expect(malformed?.aiGenerated).toBeUndefined();
      expect(malformed?.durationSeconds).toBeUndefined();
      expect(malformed?.coverUrl).toBeUndefined();
      expect(malformed?.author.verified).toBeUndefined();
      expect(malformed?.music?.original).toBeUndefined();
      expect(malformed?.feed).toBe("trending");
    }

    expect(snapshot?.sightings[4]).toMatchObject({
      videoId: "7569000000000000105",
      kind: "video",
      aiGenerated: false,
      durationSeconds: 12,
      coverUrl: "https://cdn.example/explore-105.jpg",
      feed: "explore:all",
      author: { handle: "explorer", verified: false },
      music: { title: "orig", original: true },
    });

    const sightings = snapshot?.sightings ?? [];
    const stripped = sightings.map(({
      durationSeconds: _durationSeconds,
      coverUrl: _coverUrl,
      kind: _kind,
      aiGenerated: _aiGenerated,
      feed: _feed,
      author,
      music,
      ...rest
    }) => {
      const { verified: _verified, ...plainAuthor } = author;
      const plainMusic = music ? { id: music.id, title: music.title, author: music.author } : undefined;
      return { ...rest, author: plainAuthor, music: plainMusic };
    });
    for (const ranking of ["views", "consensus"] as const) {
      const withFields = rankVideos(sightings, { ...schedule, ranking }, { cutAt: capturedAt });
      const withoutFields = rankVideos(stripped, { ...schedule, ranking }, { cutAt: capturedAt });
      expect(withFields.map((row) => [row.rank, row.videoId, row.metrics.views])).toEqual(
        withoutFields.map((row) => [row.rank, row.videoId, row.metrics.views]),
      );
    }

    books = new BookManager({ libraryDir: join(root, "books") });
    const control = await ensureControlBook(books, {
      ...schedule,
      sources: [{ id: "omkar", options: { explore: true } }],
    });
    await sampleTrending(control.engine, capturedAt, signal, new Map([["omkar", source()]]));
    const ledger = readLedger(control.engine, "2026-10-28");
    expect(ledger.sightings).toHaveLength(5);
    expect(ledger.sightings[0]).toMatchObject({
      videoId: "7569000000000000101",
      kind: "video",
      aiGenerated: true,
      durationSeconds: 18,
      coverUrl: "https://cdn.example/video-101.jpg",
      feed: "trending",
      author: { verified: true },
      music: { original: true },
    });
    expect(ledger.sightings[1]).toMatchObject({
      videoId: "7569000000000000102",
      kind: "photo",
      coverUrl: "https://cdn.example/photo-102.jpg",
      feed: "trending",
    });
    expect(ledger.sightings[4]).toMatchObject({
      videoId: "7569000000000000105",
      feed: "explore:all",
      durationSeconds: 12,
      aiGenerated: false,
    });
  }, testBudget(60_000));
});
