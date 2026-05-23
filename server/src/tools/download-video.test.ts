import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue, registerJobHandler } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

describe("download_video tool", () => {
  let client: Client;
  let tempDir: string;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  }, 30_000);

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-download-video-test-"));
    client = await createTestClient(tempDir);
    // Stub the real handler: these tests cover the tool's enqueue-time
    // validation, not the download. The real handler shells out to yt-dlp,
    // which won't return for a fake URL — and runner.stop() in the next
    // test's setProjectsDir blocks until in-flight jobs drain, blowing the
    // beforeEach hook timeout.
    registerJobHandler("download_video", async () => ({ stubbed: true }));
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error for invalid timestamp", async () => {
    const result = await client.callTool({
      name: "download_video",
      arguments: {
        url: "https://example.com/video",
        project_slug: "test-proj",
        start_time: "not-a-time",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Cannot parse timestamp");
  });

  it("returns error when full=true with start_time", async () => {
    const result = await client.callTool({
      name: "download_video",
      arguments: {
        url: "https://example.com/video",
        project_slug: "test-proj",
        start_time: "30",
        full: true,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Cannot specify");
  });

  it("returns error when start_time >= end_time", async () => {
    const result = await client.callTool({
      name: "download_video",
      arguments: {
        url: "https://example.com/video",
        project_slug: "test-proj",
        start_time: "60",
        end_time: "30",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("must be less");
  });

  it("enqueues job for any URL (OG fetch failure is non-fatal)", async () => {
    const result = await client.callTool({
      name: "download_video",
      arguments: {
        url: "http://127.0.0.1:9/not-a-real-video-url-12345",
        project_slug: "test-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.assetId).toBeDefined();
    expect(parsed.job_id).toBeDefined();
    expect(parsed.status).toBe("enqueued");
  });

  it("returns error when start_time equals end_time", async () => {
    const result = await client.callTool({
      name: "download_video",
      arguments: {
        url: "https://example.com/video",
        project_slug: "test-proj",
        start_time: "30",
        end_time: "30",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("must be less");
  });

  it("returns error when full=true with end_time", async () => {
    const result = await client.callTool({
      name: "download_video",
      arguments: {
        url: "https://example.com/video",
        project_slug: "test-proj",
        end_time: "60",
        full: true,
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Cannot specify");
  });
});
