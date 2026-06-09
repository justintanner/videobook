import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createTestClient } from "../test-client.js";
import { queue, registerJobHandler } from "../queue.js";

type TextContent = Array<{ type: string; text: string }>;
type EnvName =
  | "B2_ACCESS_KEY_ID"
  | "B2_SECRET_ACCESS_KEY"
  | "B2_REGION"
  | "B2_BUCKET"
  | "ELEVENLABS_API_KEY";

const envNames: EnvName[] = [
  "B2_ACCESS_KEY_ID",
  "B2_SECRET_ACCESS_KEY",
  "B2_REGION",
  "B2_BUCKET",
  "ELEVENLABS_API_KEY",
];

function captureEnv(): Record<EnvName, string | undefined> {
  return {
    B2_ACCESS_KEY_ID: process.env.B2_ACCESS_KEY_ID,
    B2_SECRET_ACCESS_KEY: process.env.B2_SECRET_ACCESS_KEY,
    B2_REGION: process.env.B2_REGION,
    B2_BUCKET: process.env.B2_BUCKET,
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  };
}

function restoreEnv(snapshot: Record<EnvName, string | undefined>): void {
  for (const name of envNames) {
    const value = snapshot[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function clearArchiveEnv(): void {
  for (const name of envNames) {
    delete process.env[name];
  }
}

function setValidArchiveEnv(): void {
  process.env.B2_ACCESS_KEY_ID = "fake-access-key";
  process.env.B2_SECRET_ACCESS_KEY = "fake-secret-key";
  process.env.B2_REGION = "us-west-004";
  process.env.B2_BUCKET = "archive-bucket";
  process.env.ELEVENLABS_API_KEY = "fake-elevenlabs-key";
}

describe("archive MCP tools", () => {
  let client: Client | undefined;
  let tempDir: string | undefined;
  let envSnapshot: Record<EnvName, string | undefined> = captureEnv();

  afterEach(async () => {
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
    restoreEnv(envSnapshot);
    client = undefined;
    tempDir = undefined;
  });

  async function makeClient(): Promise<Client> {
    envSnapshot = captureEnv();
    tempDir = await mkdtemp(join(tmpdir(), "videocity-archive-tool-test-"));
    client = await createTestClient(tempDir);
    return client;
  }

  it("rejects archive_clip when both source forms are supplied", async () => {
    const c = await makeClient();
    const result = await c.callTool({
      name: "archive_clip",
      arguments: { url: "https://example.com/video", asset_id: "vid" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0]?.text).toContain("exactly one");
  });

  it("reports missing B2 configuration before enqueueing archive_clip", async () => {
    const c = await makeClient();
    clearArchiveEnv();
    const result = await c.callTool({
      name: "archive_clip",
      arguments: { url: "https://example.com/video" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0]?.text).toContain("Missing B2 configuration");
  });

  it("reports missing B2 configuration for search_archive", async () => {
    const c = await makeClient();
    clearArchiveEnv();
    const result = await c.callTool({
      name: "search_archive",
      arguments: { topics: ["AI"] },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0]?.text).toContain("Missing B2 configuration");
  });

  it("rejects invalid restore archive IDs before checking B2", async () => {
    const c = await makeClient();
    clearArchiveEnv();
    const result = await c.callTool({
      name: "restore_archive_clips",
      arguments: { project_slug: "test-proj", archive_ids: ["not-an-id"] },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0]?.text).toContain("Invalid archive_id");
  });

  it("reports missing B2 configuration for restore_archive_clips", async () => {
    const c = await makeClient();
    clearArchiveEnv();
    const result = await c.callTool({
      name: "restore_archive_clips",
      arguments: { project_slug: "test-proj", archive_ids: ["a".repeat(64)] },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0]?.text).toContain("Missing B2 configuration");
  });

  it("enqueues a URL archive without requiring a caller-supplied project", async () => {
    const c = await makeClient();
    setValidArchiveEnv();
    registerJobHandler("archive_clip", async (payload) => payload);

    const result = await c.callTool({
      name: "archive_clip",
      arguments: {
        url: "example.com/video",
        title: "Interview",
        topics: ["AI", "Cinema"],
        people: ["Ada Lovelace", "Grace Hopper"],
        tag_audio_events: false,
        diarize: false,
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(parsed.status).toBe("enqueued");
    expect(typeof parsed.job_id).toBe("string");
    expect(typeof parsed.ingest_id).toBe("string");
    expect(parsed.archive_id).toBeNull();
  });
});
