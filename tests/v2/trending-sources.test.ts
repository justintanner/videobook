import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BookManager } from "../../server/src/book-manager.js";
import { withBookContext } from "../../server/src/book-context.js";
import { flushHarCaptures } from "../../server/src/har-capture.js";
import { harDirectory } from "../../server/src/har-settings.js";
import { sampleTrending } from "../../server/src/jobs/trending-sample.js";
import { cutTrending } from "../../server/src/jobs/trending-cut.js";
import { enqueueOptions } from "../../server/src/queue.js";
import { testBudget } from "../../server/src/test-budget.js";
import { ensureControlBook } from "../../server/src/trending/control-book.js";
import { readLedger, readSourceHealth } from "../../server/src/trending/ledger.js";
import { endlessSource } from "../../server/src/trending/sources/endless.js";
import { tiktokCreativeCenterSource } from "../../server/src/trending/sources/tiktok-creative-center.js";
import { cutAt, schedule } from "./trending-fixtures.js";

const fixtures = new URL("./fixtures/trending/", import.meta.url);
let server: Server;
let baseURL: string;
let root: string;
let books: BookManager | undefined;
let status: number;
let headers: Record<string, string>;
let invalid: string;
let recorded: boolean;
let now: number;
let requests: URL[];
let home: string | undefined;
let capture: string | undefined;
const signal = new AbortController().signal;
const input = { country: "TH", window: "trending" as const, limit: 10 };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trending-sources-"));
  home = process.env.VIDEOBOOK_HOME;
  capture = process.env.VIDEOBOOK_HAR_CAPTURE;
  process.env.VIDEOBOOK_HOME = root;
  process.env.VIDEOBOOK_HAR_CAPTURE = "off";
  status = 200;
  headers = {};
  invalid = "";
  recorded = false;
  now = Date.parse(cutAt);
  requests = [];
  const data = Object.fromEntries(await Promise.all(["endless-th", "creative-overview", "creative-th", "creative-th-organic"].flatMap((name) => [name, `recorded-${name}`]).map(async (name) => [name, await readFile(new URL(`${name}.json`, fixtures), "utf8")])));
  server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    requests.push(url);
    response.writeHead(status, { "content-type": "application/json", ...headers });
    if (status !== 200) { response.end('{"message":"try later"}'); return; }
    if (invalid && url.pathname.includes(invalid)) { response.end('{"BaseResp":{"StatusCode":0},"entityInfos":[{}]}'); return; }
    const name = url.pathname.includes("/social/") ? "endless-th" : url.pathname.endsWith("Overview") ? "creative-overview"
      : url.searchParams.get("organicOnly") === "true" ? "creative-th-organic" : "creative-th";
    response.end(data[recorded ? `recorded-${name}` : name]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  baseURL = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await flushHarCaptures();
  await books?.close();
  books = undefined;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (home === undefined) delete process.env.VIDEOBOOK_HOME; else process.env.VIDEOBOOK_HOME = home;
  if (capture === undefined) delete process.env.VIDEOBOOK_HAR_CAPTURE; else process.env.VIDEOBOOK_HAR_CAPTURE = capture;
  await rm(root, { recursive: true, force: true });
});

function sources() {
  return new Map([
    ["endless", endlessSource({ baseURL, now: () => now })],
    ["tiktok-creative-center", tiktokCreativeCenterSource({ baseURL, now: () => now })],
  ]);
}

describe("public trending source adapters", () => {
  it("accepts sanitized Thailand responses recorded by apicity on 2026-10-28", async () => {
    recorded = true;
    const registry = sources();
    const endless = await registry.get("endless")!.sample(input, { signal });
    const creative = await registry.get("tiktok-creative-center")!.sample(input, { signal });
    expect(endless?.sightings).toHaveLength(30);
    expect(endless?.sightings[0]).toMatchObject({ videoId: "7683122683768343829", metrics: { views: 124237747 } });
    expect(creative?.sightings).toHaveLength(4);
    expect(creative?.sightings[0]).toMatchObject({ videoId: "7698250766473071893", isAd: true });
    expect(creative?.sightings.some((row) => !row.isAd)).toBe(true);
  });

  it("normalizes Endless and requests every supported country slug once", async () => {
    const source = endlessSource({ baseURL });
    const snapshot = await source.sample(input, { signal });
    expect(snapshot?.sightings[0]).toMatchObject({ videoId: "7569000000000000001", originRegion: "TH", metrics: { views: 12000, likes: 200 }, author: { handle: "thai" }, isAd: false });
    expect(snapshot?.sightings[1].isAd).toBe(true);
    expect(snapshot?.details?.longest).toHaveLength(1);
    const countries = "AR BR CA CL CO DO EG ID JP MY MX PE PH SA TH TR GB US VE VN".split(" ");
    for (const country of countries) expect(await source.sample({ ...input, country }, { signal })).toBeDefined();
    expect(new Set(requests.map((url) => url.pathname)).size).toBe(20);
    expect(requests.at(-1)?.pathname).toMatch(/\/vietnam$/);
    expect(await source.sample({ ...input, country: "XX" }, { signal })).toBeUndefined();
    expect(source.health().lastError).toContain("does not support");
  });

  it.each([429, 503])("backs off HTTP %s across source recreation and recovers", async (code) => {
    const source = endlessSource({ baseURL, now: () => now });
    status = code;
    headers = { "Retry-After": "120" };
    expect(await source.sample(input, { signal })).toBeUndefined();
    const previousHealth = source.health();
    expect(previousHealth.retryAfter).toBe("2026-10-28T00:02:00.000Z");
    const resumed = endlessSource({ baseURL, now: () => now });
    expect(await resumed.sample(input, { signal, previousHealth })).toBeUndefined();
    expect(requests).toHaveLength(1);
    now += 120_000;
    status = 200;
    headers = {};
    expect(await resumed.sample(input, { signal, previousHealth })).toBeDefined();
    expect(resumed.health().lastError).toBeUndefined();
  });

  it("honors an exhausted successful rate limit and rejects a malformed Endless response", async () => {
    const source = endlessSource({ baseURL, now: () => now });
    headers = { "RateLimit-Remaining": "0", "RateLimit-Reset": "300" };
    expect(await source.sample(input, { signal })).toBeDefined();
    expect(await source.sample(input, { signal })).toBeUndefined();
    expect(requests).toHaveLength(1);
    now += 300_000;
    headers = {};
    invalid = "/social/";
    expect(await source.sample(input, { signal })).toBeUndefined();
    expect(source.health().lastError).toContain("schema mismatch");
  });

  it("preserves large TikTok IDs and uses weekly views, lifetime views and the organic list", async () => {
    const source = tiktokCreativeCenterSource({ baseURL });
    const snapshot = await source.sample(input, { signal });
    expect(requests).toHaveLength(3);
    expect(Object.fromEntries(requests[1].searchParams)).toMatchObject({ countryCode: "TH", periodDimension: "3", orderByMetric: "1", organicOnly: "false", periodEndTimestamp: "1792886400" });
    expect(requests[2].searchParams.get("organicOnly")).toBe("true");
    expect(snapshot?.sightings[0]).toMatchObject({ videoId: "7569000000000000001", author: { id: "7569000000000000999", followers: 1000 }, windowViews: 9000, metrics: { views: 12000 }, isAd: false, fallback: true });
    expect(snapshot?.sightings[0].url).toBe("https://www.tiktok.com/@thai/video/7569000000000000001");
    expect(snapshot?.sightings[2].isAd).toBe(true);
  });

  it.each(["Overview", "ContentsList"])("disables a mismatched Creative Center %s response for this sample", async (path) => {
    const source = tiktokCreativeCenterSource({ baseURL });
    invalid = path;
    expect(await source.sample(input, { signal })).toBeUndefined();
    expect(source.health().lastError).toContain("disabled for this sample: response schema mismatch");
    expect(requests).toHaveLength(path === "Overview" ? 1 : 2);
  });

  it("cuts the remaining source when Creative Center has no usable schema", async () => {
    books = new BookManager({ libraryDir: join(root, "books") });
    const control = await ensureControlBook(books, { ...schedule, topN: 2 });
    invalid = "ContentsList";
    await sampleTrending(control.engine, cutAt, signal, sources());
    expect(readSourceHealth(control.engine)["tiktok-creative-center"].lastError).toContain("schema mismatch");
    const run = await cutTrending(control.engine, books, "2026-10-28", cutAt, async (id, payload) => {
      const selected = books!.get(String(payload.bookId));
      if (!selected.ok) throw new Error(selected.error.message);
      return selected.value.engine.jobs.queue.enqueue(enqueueOptions(id, payload)).job;
    });
    expect(run?.videos.map((row) => row.videoId)).toEqual(["7569000000000000001"]);
    expect(run?.completed).toBe(true);
  }, testBudget(60_000));

  it("persists snapshots, captures HAR, deduplicates, and cuts primary then weekly fallback", async () => {
    books = new BookManager({ libraryDir: join(root, "books") });
    const control = await ensureControlBook(books, { ...schedule, topN: 2 });
    const registry = sources();
    process.env.VIDEOBOOK_HAR_CAPTURE = "all";
    await withBookContext({ bookId: control.bookId, engine: control.engine }, () => sampleTrending(control.engine, cutAt, signal, registry));
    await sampleTrending(control.engine, "2026-10-28T06:00:00.000Z", signal, registry);
    expect(readLedger(control.engine, "2026-10-28").sightings).toHaveLength(2);
    expect(readLedger(control.engine, "2026-10-28").sourceDetails?.endless.sounds).toHaveLength(1);
    await flushHarCaptures();
    const index = (await readFile(join(harDirectory(), "index.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { provider: string });
    expect(new Set(index.map((row) => row.provider))).toEqual(new Set(["endless", "tiktok-creative-center"]));
    const run = await cutTrending(control.engine, books, "2026-10-28", cutAt, async (id, payload) => {
      const selected = books!.get(String(payload.bookId));
      if (!selected.ok) throw new Error(selected.error.message);
      return selected.value.engine.jobs.queue.enqueue(enqueueOptions(id, payload)).job;
    });
    expect(run?.videos.map((row) => [row.videoId, row.fallback])).toEqual([["7569000000000000001", false], ["7569000000000000003", true]]);
    expect(run?.videos[0].sources).toEqual(["endless", "tiktok-creative-center"]);
    expect(run?.downloads).toHaveLength(2);
    invalid = "Overview";
    await sampleTrending(control.engine, "2026-10-28T12:00:00.000Z", signal, registry);
    expect(readSourceHealth(control.engine)["tiktok-creative-center"].lastError).toContain("schema mismatch");
    expect(readSourceHealth(control.engine).endless.lastError).toBeUndefined();
  }, testBudget(90_000));
});
