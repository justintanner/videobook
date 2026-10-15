import { readPostRuntime } from "../posts/post-store.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createX } from "@apicity/x";
import type { Engine } from "videobook-engine";
import { z } from "zod";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { configureXStatusPollForTests, postToX } from "../x/post-to-x.js";
import type { PostToXResult } from "../x/post-contract.js";
import { postDef, postToolResultPayload } from "./post.js";

describe("post tool schema", () => {
  const schema = z.object(postDef().schema);

  it("accepts ordered text and image follow-ups", () => {
    const parsed = schema.parse({
      asset_id: "video",
      book_id: "book",
      platform: "x",
      text: "Title",
      followups: [
        { text: "Exact prompt", image_asset_ids: ["image-1", "image-2"] },
        { text: "@source https://x.com/source/status/123" },
      ],
    });
    expect(parsed.followups).toEqual([
      { text: "Exact prompt", image_asset_ids: ["image-1", "image-2"] },
      { text: "@source https://x.com/source/status/123" },
    ]);
  });

  it("rejects empty replies and more than four attachments", () => {
    expect(schema.safeParse({
      asset_id: "video",
      book_id: "book",
      text: "Title",
      followups: [{}],
    }).success).toBe(false);
    expect(schema.safeParse({
      asset_id: "video",
      book_id: "book",
      text: "Title",
      followups: [{ image_asset_ids: ["1", "2", "3", "4", "5"] }],
    }).success).toBe(false);
  });

  it("plans without a title but refuses to publish one", async () => {
    // The chat router validates its plan against this schema before the
    // confirm sheet can collect a title, so the schema must accept a missing
    // text while the handler still refuses to post without one.
    expect(schema.safeParse({ asset_id: "video", book_id: "book" }).success).toBe(true);
    expect(schema.parse({
      asset_id: "video",
      book_id: "book",
      text: "  Title  ",
    }).text).toBe("Title");
    for (const text of [undefined, "", "   "]) {
      const result = await postDef().handler({ asset_id: "video", book_id: "book", text });
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({ text: "A post title is required" });
    }
  });
});

function makeStubFetch(
  plan: Array<{ status: number; body: unknown }>,
): typeof fetch {
  let i = 0;
  return async (input, init) => {
    const planned = plan[i++];
    if (!planned) {
      const url = typeof input === "string" ? input : (input as URL).toString();
      throw new Error(`Stub fetch out of plan: ${(init?.method as string) ?? "GET"} ${url}`);
    }
    return new Response(JSON.stringify(planned.body), {
      status: planned.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("post tool published cell result", () => {
  let fs: Engine;
  let tempDir: string;
  let bookId: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-post-tool-"));
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

  it("includes cell_id and the grid address in the immediate post result", async () => {
    const created = await fs.artifacts.create("video", "posted clip");
    if (!created.ok) throw new Error(created.error.message);
    const assetId = created.value.artifactId;
    const write = await fs.files.write(assetId, "original.mp4", Buffer.from("fake-bytes-for-test"));
    if (!write.ok) throw new Error(write.error.message);
    const notebook = await fs.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    const source = fs.notebooks.createCell({
      type: "video",
      slot: { row: 0, column: 0 },
      outputArtifactId: assetId,
    });
    const written = await fs.notebooks.write({
      ...notebook.value,
      cells: [source],
    });
    if (!written.ok) throw new Error(written.error.message);

    const x = createX({
      accessToken: "tok",
      fetch: makeStubFetch([
        { status: 200, body: { data: { id: "MEDIA", media_key: "k", expires_after_secs: 1, size: 19 } } },
        { status: 200, body: { data: { expires_at: 1 } } },
        {
          status: 200,
          body: {
            data: {
              id: "MEDIA",
              media_key: "k",
              expires_after_secs: 1,
              size: 19,
              processing_info: { state: "succeeded" },
            },
          },
        },
        { status: 201, body: { data: { id: "TWEET", text: "clip" } } },
      ]),
    });
    const result = await postToX({
      engine: fs,
      assetId,
      bookId,
      text: "clip",
      x,
    });
    const payload = postToolResultPayload(result, "x");
    expect(payload.cell_id).toBe(result.cell_id);
    expect(payload.message).toBe(`Posted to X as ${result.cell_address}`);
    expect(String(payload.message)).toContain("@a2");
    expect(readPostRuntime(fs, result.cell_id!).x?.tweetId).toBe("TWEET");
    const after = fs.notebooks.read(notebook.value.id);
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value.cells.find((cell) => cell.id === result.cell_id)?.inputs).toMatchObject({
      post: { platform: "x", source: { cellId: source.id } },
    });
  });

  it("reports cell creation failure in the tool message without failing the post", () => {
    const result: PostToXResult = {
      status: "posted",
      tweet_id: "T1",
      tweet_url: "https://x.com/i/web/status/T1",
      media_id: "M1",
      posted_at: "2026-09-04T00:00:00.000Z",
      replies: [],
      followup_error: null,
      cell_error: "notebook write failed",
    };
    const payload = postToolResultPayload(result, "x");
    expect(payload.cell_id).toBeUndefined();
    expect(payload.message).toBe(
      "Posted to X; notebook cell could not be created: notebook write failed",
    );
  });
});
