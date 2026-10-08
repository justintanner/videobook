import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/client";
import { generationPromptSurface } from "../prompt-surfaces.js";

interface HistoryEntry {
  id: string;
  surface: string;
  prompt: string;
  params: Record<string, unknown> | null;
  created_at: number;
  book: string;
}

function parseText<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text) as T;
}

async function createProject(client: Client, slug: string) {
  await client.callTool({
    name: "create_project",
    arguments: { book_id: slug },
  });
}

async function record(
  client: Client,
  slug: string,
  surface: string,
  prompt: string,
  params?: Record<string, unknown>,
) {
  return client.callTool({
    name: "record_prompt",
    arguments: { book_id: slug, surface, prompt, params },
  });
}

async function list(client: Client, slug: string, surface: string, limit?: number) {
  const result = await client.callTool({
    name: "list_prompt_history",
    arguments: { book_id: slug, surface, ...(limit ? { limit } : {}) },
  });
  return parseText<{ entries: HistoryEntry[] }>(result);
}

describe("prompt history tools", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("list on empty project returns no entries", async () => {
    client = await createTestClient(tempDir);
    await createProject(client, "p");
    const data = await list(client, "p", "image_rewrite");
    expect(data.entries).toEqual([]);
  });

  it("record then list returns the entry with params", async () => {
    client = await createTestClient(tempDir);
    await createProject(client, "p");
    await record(client, "p", "image_rewrite", "make it pop", { model: "nano_banana" });
    const data = await list(client, "p", "image_rewrite");
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].prompt).toBe("make it pop");
    expect(data.entries[0].surface).toBe("image_rewrite");
    expect(data.entries[0].params).toEqual({ model: "nano_banana" });
    expect(typeof data.entries[0].created_at).toBe("number");
  });

  it("list returns newest-first", async () => {
    client = await createTestClient(tempDir);
    await createProject(client, "p");
    await record(client, "p", "post", "first");
    await record(client, "p", "post", "second");
    await record(client, "p", "post", "third");
    const data = await list(client, "p", "post");
    expect(data.entries.map((e) => e.prompt)).toEqual(["third", "second", "first"]);
  });

  it("surfaces are isolated", async () => {
    client = await createTestClient(tempDir);
    await createProject(client, "p");
    await record(client, "p", "image_rewrite", "image A");
    await record(client, "p", "script_rewrite", "script A");
    await record(client, "p", "image_rewrite", "image B");

    const images = await list(client, "p", "image_rewrite");
    const scripts = await list(client, "p", "script_rewrite");
    const posts = await list(client, "p", "post");

    expect(images.entries.map((e) => e.prompt)).toEqual(["image B", "image A"]);
    expect(scripts.entries.map((e) => e.prompt)).toEqual(["script A"]);
    expect(posts.entries).toEqual([]);
  });

  it("limit caps result size", async () => {
    client = await createTestClient(tempDir);
    await createProject(client, "p");
    for (let i = 0; i < 5; i += 1) {
      await record(client, "p", "chat", `msg-${i}`);
    }
    const data = await list(client, "p", "chat", 2);
    expect(data.entries).toHaveLength(2);
    expect(data.entries.map((e) => e.prompt)).toEqual(["msg-4", "msg-3"]);
  });

  it("invalid surface is rejected on record", async () => {
    client = await createTestClient(tempDir);
    await createProject(client, "p");
    const result = await record(client, "p", "not_a_real_surface", "hi");
    expect(result.isError).toBe(true);
  });

  it("invalid surface is rejected on list", async () => {
    client = await createTestClient(tempDir);
    await createProject(client, "p");
    const result = await client.callTool({
      name: "list_prompt_history",
      arguments: { book_id: "p", surface: "garbage" },
    });
    expect(result.isError).toBe(true);
  });

  it("blank prompt is silently ignored", async () => {
    client = await createTestClient(tempDir);
    await createProject(client, "p");
    await record(client, "p", "chat", "   ");
    const data = await list(client, "p", "chat");
    expect(data.entries).toEqual([]);
  });

  it("record on nonexistent project returns error", async () => {
    client = await createTestClient(tempDir);
    const result = await record(client, "no-such", "chat", "hi");
    expect(result.isError).toBe(true);
  });

  it("omitting the surface lists every surface newest-first", async () => {
    client = await createTestClient(tempDir);
    await createProject(client, "p");
    await record(client, "p", "video_generate", "video A");
    await record(client, "p", "image_generate", "image A");
    await record(client, "p", "chat", "chat A");
    const result = await client.callTool({
      name: "list_prompt_history",
      arguments: { book_id: "p" },
    });
    const data = parseText<{ entries: HistoryEntry[]; page: { total: number } }>(result);
    expect(data.entries.map((e) => e.prompt)).toEqual(["chat A", "image A", "video A"]);
    expect(data.page.total).toBe(3);
  });

  it("entries carry the book name and library scope includes the current book", async () => {
    client = await createTestClient(tempDir);
    await createProject(client, "spider-realm");
    await record(client, "spider-realm", "video_generate", "portal reveal");
    const result = await client.callTool({
      name: "list_prompt_history",
      arguments: { book_id: "spider-realm", surface: "video_generate", scope: "library" },
    });
    const data = parseText<{ entries: HistoryEntry[] }>(result);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].prompt).toBe("portal reveal");
    expect(data.entries[0].book).toMatch(/\S/);
  });

  it("maps generation cell types to their prompt surfaces", () => {
    expect(generationPromptSurface("generate_video")).toBe("video_generate");
    expect(generationPromptSurface("generate_image")).toBe("image_generate");
    expect(generationPromptSurface("generate_audio")).toBe("audio_generate");
    expect(generationPromptSurface("video")).toBeNull();
  });
});
