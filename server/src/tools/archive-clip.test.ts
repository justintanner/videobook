import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../fs.js";
import { queue, registerJobHandler } from "../queue.js";

type TextContent = Array<{ type: string; text: string }>;
type EnvName =
  | "B2_ACCESS_KEY_ID"
  | "B2_SECRET_ACCESS_KEY"
  | "B2_REGION"
  | "B2_BUCKET"
  | "ELEVENLABS_API_KEY"
  | "VIDEOBOOK_ARCHIVE_DIR";

const envNames: EnvName[] = [
  "B2_ACCESS_KEY_ID",
  "B2_SECRET_ACCESS_KEY",
  "B2_REGION",
  "B2_BUCKET",
  "ELEVENLABS_API_KEY",
  "VIDEOBOOK_ARCHIVE_DIR",
];

function captureEnv(): Record<EnvName, string | undefined> {
  return {
    B2_ACCESS_KEY_ID: process.env.B2_ACCESS_KEY_ID,
    B2_SECRET_ACCESS_KEY: process.env.B2_SECRET_ACCESS_KEY,
    B2_REGION: process.env.B2_REGION,
    B2_BUCKET: process.env.B2_BUCKET,
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
    VIDEOBOOK_ARCHIVE_DIR: process.env.VIDEOBOOK_ARCHIVE_DIR,
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

const sha = "a".repeat(64);

async function seedLocalArchiveClip(archiveDir: string): Promise<void> {
  const clipDir = join(archiveDir, "clips", sha);
  await mkdir(clipDir, { recursive: true });
  await writeFile(join(clipDir, "original.mp4"), "fake-video-bytes");
  await writeFile(join(clipDir, "transcript.txt"), "grace hopper explains compilers");
  await writeFile(join(clipDir, "archive.json"), JSON.stringify({
    schema_version: 1,
    sha256: sha,
    archive_id: sha,
    title: "Compiler Lecture",
    topics: [{ key: "compilers", label: "Compilers", source: "manual" }],
    people: [{ key: "grace-hopper", label: "Grace Hopper", source: "manual" }],
    sources: [],
    ingests: [],
    media: {
      key: `clips/${sha}/original.mp4`,
      filename: "original.mp4",
      content_type: "video/mp4",
      size_bytes: 16,
    },
    transcript: {
      json_key: `clips/${sha}/transcript.json`,
      text_key: `clips/${sha}/transcript.txt`,
      chunk_count: 1,
      provider: "elevenlabs",
    },
    duration: 60,
    created_at: "2026-06-09T00:00:00.000Z",
    updated_at: "2026-06-09T00:00:00.000Z",
  }, null, 2));
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
    client = await createTestClient(join(tempDir, "projects"));
    return client;
  }

  function useLocalArchiveDir(): string {
    const archiveDir = join(tempDir!, "archive");
    process.env.VIDEOBOOK_ARCHIVE_DIR = archiveDir;
    return archiveDir;
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

  it("reports missing ELEVENLABS_API_KEY before enqueueing archive_clip", async () => {
    const c = await makeClient();
    clearArchiveEnv();
    const result = await c.callTool({
      name: "archive_clip",
      arguments: { url: "https://example.com/video" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0]?.text).toContain("ELEVENLABS_API_KEY");
  });

  it("enqueues archive_clip without B2 configuration via the local archive fallback", async () => {
    const c = await makeClient();
    clearArchiveEnv();
    useLocalArchiveDir();
    process.env.ELEVENLABS_API_KEY = "fake-elevenlabs-key";
    registerJobHandler("archive_clip", async (payload) => payload);

    const result = await c.callTool({
      name: "archive_clip",
      arguments: { url: "https://example.com/video" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(parsed.status).toBe("enqueued");
  });

  it("searches an empty local archive without B2 configuration", async () => {
    const c = await makeClient();
    clearArchiveEnv();
    useLocalArchiveDir();
    const result = await c.callTool({
      name: "search_archive",
      arguments: { topics: ["AI"] },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(parsed.results).toEqual([]);
    expect(parsed.total).toBe(0);
  });

  it("finds seeded clips in the local archive and serves media via /archive-files", async () => {
    const c = await makeClient();
    clearArchiveEnv();
    const archiveDir = useLocalArchiveDir();
    await seedLocalArchiveClip(archiveDir);

    const result = await c.callTool({
      name: "search_archive",
      arguments: { query: "compilers" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0]?.text ?? "{}") as {
      total: number;
      results: Array<{ archive_id: string; media: { url: string | null }; transcript_excerpt: string | null }>;
    };
    expect(parsed.total).toBe(1);
    expect(parsed.results[0]?.archive_id).toBe(sha);
    expect(parsed.results[0]?.media.url).toBe(`/archive-files/clips/${sha}/original.mp4`);
    expect(parsed.results[0]?.transcript_excerpt).toContain("compilers");
  });

  it("rejects invalid restore archive IDs", async () => {
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

  it("reports missing clips when restoring from an empty local archive", async () => {
    const c = await makeClient();
    clearArchiveEnv();
    useLocalArchiveDir();
    const fs = createEngineForTest(join(tempDir!, "projects"));
    const created = await fs.projects.create();
    if (!created.ok) throw new Error(created.error.message);

    const result = await c.callTool({
      name: "restore_archive_clips",
      arguments: { project_slug: created.value.slug, archive_ids: [sha] },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0]?.text).toContain("Archive clip not found");
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
