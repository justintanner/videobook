import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createX } from "@apicity/x";
import type { Engine } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { configureXStatusPollForTests, postToX, STATUS_POLL_MIN_INTERVAL_MS } from "./post-to-x.js";
import {
  appendXPostMetadata,
  readXPostMetadata,
  POST_METADATA_FILE,
} from "./post-metadata.js";

interface RecordedRequest {
  url: string;
  method: string;
  body: string | null;
  isMultipart: boolean;
  headers: Record<string, string>;
}

interface StubResponse {
  status: number;
  body: unknown;
}

function makeStubFetch(plan: StubResponse[]): { fetch: typeof fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  let i = 0;
  const stub: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = (init?.method as string) ?? "GET";
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
      for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
        headers[k] = v;
      }
    }
    const isMultipart = init?.body instanceof FormData;
    const body = !init?.body
      ? null
      : isMultipart
        ? "[multipart]"
        : typeof init.body === "string"
          ? init.body
          : "[binary]";
    calls.push({ url, method, body, isMultipart, headers });

    const planned = plan[i++];
    if (!planned) {
      throw new Error(`Stub fetch out of plan: ${method} ${url}`);
    }
    return new Response(JSON.stringify(planned.body), {
      status: planned.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch: stub, calls };
}

async function uploadFakeAsset(
  fs: Engine,
  _bookId: string,
  prefix: string,
  ext: string,
): Promise<string> {
  const created = await fs.artifacts.create(prefix, `clip-${prefix}`);
  if (!created.ok) throw new Error(created.error.message);
  const assetId = created.value.artifactId;
  const writeResult = await fs.files.write(assetId, `original${ext}`, Buffer.from("fake-bytes-for-test")
  );
  if (!writeResult.ok) throw new Error(writeResult.error.message);
  return assetId;
}

describe("postToX helper", () => {
  let fs: Engine;
  let tempDir: string;
  let bookId: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-postx-"));
    fs = createEngineForTest(tempDir);
    bookId = fs.book.get().bookId;
  });

  afterAll(async () => {
    closeEngineForTest(tempDir, fs);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  beforeEach(() => {
    configureXStatusPollForTests({ sleep: async () => undefined });
  });

  afterEach(() => {
    configureXStatusPollForTests(null);
  });

  it("posts an image asset: initialize, single append, finalize, tweet", async () => {
    const assetId = await uploadFakeAsset(fs, bookId, "img", ".jpg");

    const { fetch: stubFetch, calls } = makeStubFetch([
      { status: 200, body: { data: { id: "MEDIA_42", media_key: "k", expires_after_secs: 86400, size: 19 } } },
      { status: 200, body: { data: { expires_at: 12345 } } },
      { status: 200, body: { data: { id: "MEDIA_42", media_key: "k", expires_after_secs: 86400, size: 19 } } },
      { status: 201, body: { data: { id: "TWEET_99", text: "hi" } } },
    ]);
    const x = createX({ accessToken: "test-token", fetch: stubFetch });

    const result = await postToX({
      engine: fs,
      assetId,
      bookId,
      text: "hi",
      x,
    });

    expect(result.tweet_id).toBe("TWEET_99");
    expect(result.tweet_url).toBe("https://x.com/i/web/status/TWEET_99");
    expect(result.media_id).toBe("MEDIA_42");
    expect(typeof result.posted_at).toBe("string");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.x.com/2/media/upload/initialize",
      "POST https://api.x.com/2/media/upload/MEDIA_42/append",
      "POST https://api.x.com/2/media/upload/MEDIA_42/finalize",
      "POST https://api.x.com/2/tweets",
    ]);
    expect(calls[1].isMultipart).toBe(true);
    const tweetBody = JSON.parse(calls[3].body!);
    expect(tweetBody.media.media_ids).toEqual(["MEDIA_42"]);
    expect(tweetBody.text).toBe("hi");

    const meta = await readXPostMetadata(fs, assetId);
    expect(meta.version).toBe(2);
    expect(meta.asset_id).toBe(assetId);
    expect(meta.posts).toHaveLength(1);
    expect(meta.posts[0]).toMatchObject({
      tweet_id: "TWEET_99",
      tweet_url: "https://x.com/i/web/status/TWEET_99",
      media_id: "MEDIA_42",
      text: "hi",
      scheduled_for: null,
      schedule_id: null,
    });
    expect(meta.posts[0].posted_at).toBe(result.posted_at);
  });

  it("appends a second entry to .post.x.json on a follow-up post and records schedule provenance", async () => {
    const assetId = await uploadFakeAsset(fs, bookId, "img", ".jpg");

    const firstPlan = makeStubFetch([
      { status: 200, body: { data: { id: "M1", media_key: "k", expires_after_secs: 86400, size: 19 } } },
      { status: 200, body: { data: { expires_at: 1 } } },
      { status: 200, body: { data: { id: "M1", media_key: "k", expires_after_secs: 86400, size: 19 } } },
      { status: 201, body: { data: { id: "T1", text: "" } } },
    ]);
    const x1 = createX({ accessToken: "tok", fetch: firstPlan.fetch });
    await postToX({ engine: fs, assetId, bookId, text: "first", x: x1 });

    const secondPlan = makeStubFetch([
      { status: 200, body: { data: { id: "M2", media_key: "k", expires_after_secs: 86400, size: 19 } } },
      { status: 200, body: { data: { expires_at: 1 } } },
      { status: 200, body: { data: { id: "M2", media_key: "k", expires_after_secs: 86400, size: 19 } } },
      { status: 201, body: { data: { id: "T2", text: "" } } },
    ]);
    const x2 = createX({ accessToken: "tok", fetch: secondPlan.fetch });
    const scheduledFor = new Date(Date.now() - 60_000).toISOString();
    await postToX({
      engine: fs,
      assetId,
      bookId,
      text: "second",
      x: x2,
      scheduleId: "sched-abc",
      scheduledFor,
    });

    const meta = await readXPostMetadata(fs, assetId);
    expect(meta.posts).toHaveLength(2);
    expect(meta.posts[0].tweet_id).toBe("T1");
    expect(meta.posts[1]).toMatchObject({
      tweet_id: "T2",
      schedule_id: "sched-abc",
      scheduled_for: scheduledFor,
      text: "second",
    });
  });

  it("post metadata file is named .post.x.json", () => {
    expect(POST_METADATA_FILE).toBe(".post.x.json");
  });

  it("reads version 1 metadata and upgrades it on the next append", async () => {
    const assetId = await uploadFakeAsset(fs, bookId, "img", ".jpg");
    const legacyEntry = {
      tweet_id: "LEGACY",
      tweet_url: "https://x.com/i/web/status/LEGACY",
      posted_at: "2026-01-01T00:00:00.000Z",
      media_id: "LEGACY_MEDIA",
      text: "legacy",
      scheduled_for: null,
      schedule_id: null,
    };
    const write = await fs.files.write(
      assetId,
      POST_METADATA_FILE,
      Buffer.from(JSON.stringify({
        version: 1,
        asset_id: assetId,
        posts: [legacyEntry],
      })),
    );
    if (!write.ok) throw new Error(write.error.message);

    expect((await readXPostMetadata(fs, assetId)).version).toBe(1);
    await appendXPostMetadata({
      engine: fs,
      assetId,
      entry: {
        ...legacyEntry,
        tweet_id: "CURRENT",
        tweet_url: "https://x.com/i/web/status/CURRENT",
        status: "posted",
        replies: [],
        followup_error: null,
      },
    });
    const upgraded = await readXPostMetadata(fs, assetId);
    expect(upgraded.version).toBe(2);
    expect(upgraded.posts.map((entry) => entry.tweet_id)).toEqual([
      "LEGACY",
      "CURRENT",
    ]);
  });

  it("polls processing_info until succeeded for video", async () => {
    const assetId = await uploadFakeAsset(fs, bookId, "vid", ".mp4");

    const { fetch: stubFetch, calls } = makeStubFetch([
      { status: 200, body: { data: { id: "VID_1", media_key: "k", expires_after_secs: 86400, size: 19 } } },
      { status: 200, body: { data: { expires_at: 1 } } },
      {
        status: 200,
        body: {
          data: {
            id: "VID_1", media_key: "k", expires_after_secs: 86400, size: 19,
            processing_info: { type: "video", state: "in_progress", check_after_secs: 0 },
          },
        },
      },
      {
        status: 200,
        body: {
          data: {
            id: "VID_1", media_key: "k", expires_after_secs: 86400, size: 19,
            processing_info: { type: "video", state: "succeeded" },
          },
        },
      },
      { status: 201, body: { data: { id: "TWEET_VID", text: "" } } },
    ]);
    const x = createX({ accessToken: "test-token", fetch: stubFetch });

    const result = await postToX({ engine: fs, assetId, bookId, x });
    expect(result.tweet_id).toBe("TWEET_VID");
    expect(STATUS_POLL_MIN_INTERVAL_MS).toBe(2_000);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.x.com/2/media/upload/initialize",
      "POST https://api.x.com/2/media/upload/VID_1/append",
      "POST https://api.x.com/2/media/upload/VID_1/finalize",
      "GET https://api.x.com/2/media/upload?media_id=VID_1&command=STATUS",
      "POST https://api.x.com/2/tweets",
    ]);
  });

  it("rejects unsupported file extensions", async () => {
    const created = await fs.artifacts.create("aud", "song");
    if (!created.ok) throw new Error(created.error.message);
    await fs.files.write(created.value.artifactId, "original.mp3", Buffer.from("audio")
    );

    const x = createX({ accessToken: "test-token", fetch: makeStubFetch([]).fetch });
    await expect(
      postToX({ engine: fs, assetId: created.value.artifactId, bookId, x }),
    ).rejects.toThrow(/unsupported media file/i);
  });

  it("surfaces X API error messages", async () => {
    const assetId = await uploadFakeAsset(fs, bookId, "img", ".png");
    const { fetch: stubFetch } = makeStubFetch([
      { status: 401, body: { title: "Unauthorized", detail: "Bad token", status: 401 } },
    ]);
    const x = createX({ accessToken: "test-token", fetch: stubFetch });
    await expect(
      postToX({ engine: fs, assetId, bookId, x, text: "x" }),
    ).rejects.toThrow(/Bad token/);
  });

  it("uploads all reply media before publishing a chained thread", async () => {
    const rootAssetId = await uploadFakeAsset(fs, bookId, "vid", ".mp4");
    const firstImageId = await uploadFakeAsset(fs, bookId, "img", ".png");
    const secondImageId = await uploadFakeAsset(fs, bookId, "img", ".jpg");
    const { fetch: stubFetch, calls } = makeStubFetch([
      { status: 200, body: { data: { id: "ROOT_MEDIA", media_key: "k", expires_after_secs: 1, size: 19 } } },
      { status: 200, body: { data: { expires_at: 1 } } },
      { status: 200, body: { data: { id: "ROOT_MEDIA", media_key: "k", expires_after_secs: 1, size: 19 } } },
      { status: 200, body: { data: { id: "IMAGE_1", media_key: "k", expires_after_secs: 1, size: 19 } } },
      { status: 200, body: { data: { expires_at: 1 } } },
      { status: 200, body: { data: { id: "IMAGE_1", media_key: "k", expires_after_secs: 1, size: 19 } } },
      { status: 200, body: { data: { id: "IMAGE_2", media_key: "k", expires_after_secs: 1, size: 19 } } },
      { status: 200, body: { data: { expires_at: 1 } } },
      { status: 200, body: { data: { id: "IMAGE_2", media_key: "k", expires_after_secs: 1, size: 19 } } },
      { status: 201, body: { data: { id: "ROOT_TWEET", text: "root" } } },
      { status: 201, body: { data: { id: "REPLY_1", text: "prompt" } } },
      { status: 201, body: { data: { id: "REPLY_2", text: "source" } } },
    ]);
    const x = createX({ accessToken: "test-token", fetch: stubFetch });

    const result = await postToX({
      engine: fs,
      assetId: rootAssetId,
      bookId,
      text: "root",
      followups: [
        {
          text: "Exact generation prompt",
          image_asset_ids: [firstImageId, secondImageId],
        },
        { text: "@source https://x.com/source/status/123" },
      ],
      x,
    });

    expect(result.status).toBe("posted");
    expect(result.replies.map((reply) => reply.tweet_id)).toEqual([
      "REPLY_1",
      "REPLY_2",
    ]);
    expect(calls.slice(0, 9).every((call) => call.url.includes("media/upload")))
      .toBe(true);
    const rootBody = JSON.parse(calls[9].body!);
    const firstReplyBody = JSON.parse(calls[10].body!);
    const secondReplyBody = JSON.parse(calls[11].body!);
    expect(rootBody).toMatchObject({
      text: "root",
      media: { media_ids: ["ROOT_MEDIA"] },
    });
    expect(firstReplyBody).toMatchObject({
      text: "Exact generation prompt",
      media: { media_ids: ["IMAGE_1", "IMAGE_2"] },
      reply: { in_reply_to_tweet_id: "ROOT_TWEET" },
    });
    expect(secondReplyBody).toMatchObject({
      text: "@source https://x.com/source/status/123",
      reply: { in_reply_to_tweet_id: "REPLY_1" },
    });

    const metadata = await readXPostMetadata(fs, rootAssetId);
    expect(metadata.posts.at(-1)).toMatchObject({
      status: "posted",
      replies: [
        { tweet_id: "REPLY_1", media_ids: ["IMAGE_1", "IMAGE_2"] },
        { tweet_id: "REPLY_2", media_ids: [] },
      ],
      followup_error: null,
    });
  });

  it("reports partial success without retrying the root after a reply fails", async () => {
    const assetId = await uploadFakeAsset(fs, bookId, "img", ".png");
    const { fetch: stubFetch, calls } = makeStubFetch([
      { status: 200, body: { data: { id: "MEDIA", media_key: "k", expires_after_secs: 1, size: 19 } } },
      { status: 200, body: { data: { expires_at: 1 } } },
      { status: 200, body: { data: { id: "MEDIA", media_key: "k", expires_after_secs: 1, size: 19 } } },
      { status: 201, body: { data: { id: "ROOT", text: "root" } } },
      { status: 500, body: { title: "Reply failed", detail: "Temporary X error", status: 500 } },
    ]);
    const x = createX({ accessToken: "test-token", fetch: stubFetch });

    const result = await postToX({
      engine: fs,
      assetId,
      bookId,
      text: "root",
      followups: [{ text: "first reply" }, { text: "must not run" }],
      x,
    });

    expect(result).toMatchObject({
      status: "partially_posted",
      tweet_id: "ROOT",
      replies: [],
      followup_error: {
        reply_number: 1,
        message: expect.stringContaining("Temporary X error"),
      },
    });
    expect(calls.filter((call) => call.url === "https://api.x.com/2/tweets"))
      .toHaveLength(2);
  });
});
