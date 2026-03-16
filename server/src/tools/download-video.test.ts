import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

describe("download_video_file tool", () => {
  let client: Client;
  let tempDir: string;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-download-video-test-"));
    client = await createTestClient(tempDir);
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
      name: "download_video_file",
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
      name: "download_video_file",
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
      name: "download_video_file",
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
      name: "download_video_file",
      arguments: {
        url: "https://example.com/not-a-real-video-url-12345",
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
      name: "download_video_file",
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
      name: "download_video_file",
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
