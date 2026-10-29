import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { omkarSource } from "../../server/src/trending/sources/omkar.js";
import { rankVideos } from "../../server/src/trending/ranking.js";
import { cutAt, schedule } from "./trending-fixtures.js";

let server: Server;
let baseURL: string;
let root: string;
let status: number;
let body: string;
let home: string | undefined;
let requests: URL[];
const signal = new AbortController().signal;
const input = { country: "TH", window: "trending" as const, limit: 10 };
const capturedAt = cutAt;

function video(id: string, isAd: boolean, views: number) {
  return {
    id, link: `https://www.tiktok.com/@thai/video/${id}`, description: `caption ${id}`, title: null,
    language: "th", created_at: "2026-10-27T00:00:00.000Z", location_created: "TH", is_ad: isAd,
    stats: { play_count: views, like_count: 10, comment_count: 2, share_count: 3, save_count: 4 },
    author: { id: "author-1", username: "thai", nickname: "Thai" },
    author_stats: { follower_count: 1000 },
    music: { id: "sound-1", title: "song", author_name: "artist" },
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
  requests = [];
  server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    requests.push(url);
    response.writeHead(status, { "content-type": "application/json" });
    if (status !== 200) {
      response.end('{"code":"rate_limited","message":"slow down"}');
      return;
    }
    response.end(url.pathname === "/feed/explore" ? explored : body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  baseURL = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
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
  });
});
