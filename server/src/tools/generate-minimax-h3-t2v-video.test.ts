import { createEngineForTest } from "../fs.js";
import { isUuidV7 } from "videobook-engine";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "@modelcontextprotocol/client";
import { createTestClient } from "../test-client.js";

type TextContent = Array<{ type: string; text: string }>;

describe("generate_minimax_h3_t2v_video tool", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.KIE_API_KEY;

  beforeEach(async () => {
    process.env.KIE_API_KEY = "test-key";
    tempDir = await mkdtemp(join(tmpdir(), "videocity-minimax-h3-t2v-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterEach(async () => {
    if (originalKey) {
      process.env.KIE_API_KEY = originalKey;
    } else {
      delete process.env.KIE_API_KEY;
    }
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error when KIE_API_KEY is not set", async () => {
    delete process.env.KIE_API_KEY;
    const result = await client.callTool({
      name: "generate_kie_minimax_h3_text_to_video",
      arguments: {
        book_id: "test-proj",
        prompt: "a futuristic city",
        aspect_ratio: "16:9",
        duration: "6",
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("KIE_API_KEY environment variable is not set");
  });

  it("creates a vid artifact and enqueues a generate_minimax_h3_t2v_video job", async () => {
    const fs = createEngineForTest(tempDir);
    const result = await client.callTool({
      name: "generate_kie_minimax_h3_text_to_video",
      arguments: {
        book_id: "test-proj",
        prompt: "a futuristic city",
        aspect_ratio: "16:9",
        duration: "6",
        resolution: "2K",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.status).toBe("enqueued");
    expect(isUuidV7(parsed.vid_asset_id)).toBe(true);
    const created = fs.artifacts.get(parsed.vid_asset_id);
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.kind).toBe("video");
    expect(parsed.job_id).toBeDefined();

    const jobs = fs.jobs.queue.list({
      states: ["queued", "running", "completing", "done", "failed", "aborted"],
    });
    const job = jobs.find((j) => j.type === "generate_minimax_h3_t2v_video");
    expect(job).toBeDefined();
    expect(job?.payload).toMatchObject({
      type: "generate_minimax_h3_t2v_video",
      vidAssetId: parsed.vid_asset_id,
      bookId: fs.book.get().bookId,
      prompt: "a futuristic city",
      aspect_ratio: "16:9",
      duration: "6",
      resolution: "2K",
    });
  });
});
