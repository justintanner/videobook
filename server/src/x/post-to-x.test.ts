import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createX } from "@apicity/x";
import type { Engine } from "videobook-engine";
import { createEngineForTest } from "../fs.js";
import { postToX } from "./post-to-x.js";
import { readXPostMetadata, POST_METADATA_FILE } from "./post-metadata.js";

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
  projectSlug: string,
  prefix: string,
  ext: string,
): Promise<string> {
  const created = await fs.artifacts.create(prefix, `clip-${prefix}`, projectSlug);
  if (!created.ok) throw new Error(created.error.message);
  const assetId = created.value.slug;
  const writeResult = await fs.files.write(
    assetId,
    `original${ext}`,
    Buffer.from("fake-bytes-for-test"),
    projectSlug,
  );
  if (!writeResult.ok) throw new Error(writeResult.error.message);
  return assetId;
}

describe("postToX helper", () => {
  let fs: Engine;
  let tempDir: string;
  const projectSlug = "post-test";

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-postx-"));
    fs = createEngineForTest(tempDir);
    const created = await fs.projects.create(projectSlug);
    if (!created.ok) throw new Error(created.error.message);
  });

  afterAll(async () => {
    fs.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("posts an image asset: initialize, single append, finalize, tweet", async () => {
    const assetId = await uploadFakeAsset(fs, projectSlug, "img", ".jpg");

    const { fetch: stubFetch, calls } = makeStubFetch([
      { status: 200, body: { data: { id: "MEDIA_42", media_key: "k", expires_after_secs: 86400, size: 19 } } },
      { status: 200, body: { data: { expires_at: 12345 } } },
      { status: 200, body: { data: { id: "MEDIA_42", media_key: "k", expires_after_secs: 86400, size: 19 } } },
      { status: 201, body: { data: { id: "TWEET_99", text: "hi" } } },
    ]);
    const x = createX({ accessToken: "test-token", fetch: stubFetch });

    const result = await postToX({
      fs,
      assetId,
      projectSlug,
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

    const meta = await readXPostMetadata(fs, assetId, projectSlug);
    expect(meta.version).toBe(1);
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
    const assetId = await uploadFakeAsset(fs, projectSlug, "img", ".jpg");

    const firstPlan = makeStubFetch([
      { status: 200, body: { data: { id: "M1", media_key: "k", expires_after_secs: 86400, size: 19 } } },
      { status: 200, body: { data: { expires_at: 1 } } },
      { status: 200, body: { data: { id: "M1", media_key: "k", expires_after_secs: 86400, size: 19 } } },
      { status: 201, body: { data: { id: "T1", text: "" } } },
    ]);
    const x1 = createX({ accessToken: "tok", fetch: firstPlan.fetch });
    await postToX({ fs, assetId, projectSlug, text: "first", x: x1 });

    const secondPlan = makeStubFetch([
      { status: 200, body: { data: { id: "M2", media_key: "k", expires_after_secs: 86400, size: 19 } } },
      { status: 200, body: { data: { expires_at: 1 } } },
      { status: 200, body: { data: { id: "M2", media_key: "k", expires_after_secs: 86400, size: 19 } } },
      { status: 201, body: { data: { id: "T2", text: "" } } },
    ]);
    const x2 = createX({ accessToken: "tok", fetch: secondPlan.fetch });
    const scheduledFor = new Date(Date.now() - 60_000).toISOString();
    await postToX({
      fs,
      assetId,
      projectSlug,
      text: "second",
      x: x2,
      scheduleId: "sched-abc",
      scheduledFor,
    });

    const meta = await readXPostMetadata(fs, assetId, projectSlug);
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

  it("polls processing_info until succeeded for video", async () => {
    const assetId = await uploadFakeAsset(fs, projectSlug, "vid", ".mp4");

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

    const result = await postToX({ fs, assetId, projectSlug, x });
    expect(result.tweet_id).toBe("TWEET_VID");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.x.com/2/media/upload/initialize",
      "POST https://api.x.com/2/media/upload/VID_1/append",
      "POST https://api.x.com/2/media/upload/VID_1/finalize",
      "GET https://api.x.com/2/media/upload?media_id=VID_1&command=STATUS",
      "POST https://api.x.com/2/tweets",
    ]);
  });

  it("rejects unsupported file extensions", async () => {
    const created = await fs.artifacts.create("aud", "song", projectSlug);
    if (!created.ok) throw new Error(created.error.message);
    await fs.files.write(
      created.value.slug,
      "original.mp3",
      Buffer.from("audio"),
      projectSlug,
    );

    const x = createX({ accessToken: "test-token", fetch: makeStubFetch([]).fetch });
    await expect(
      postToX({ fs, assetId: created.value.slug, projectSlug, x }),
    ).rejects.toThrow(/unsupported media file/i);
  });

  it("surfaces X API error messages", async () => {
    const assetId = await uploadFakeAsset(fs, projectSlug, "img", ".png");
    const { fetch: stubFetch } = makeStubFetch([
      { status: 401, body: { title: "Unauthorized", detail: "Bad token", status: 401 } },
    ]);
    const x = createX({ accessToken: "test-token", fetch: stubFetch });
    await expect(
      postToX({ fs, assetId, projectSlug, x, text: "x" }),
    ).rejects.toThrow(/Bad token/);
  });
});
