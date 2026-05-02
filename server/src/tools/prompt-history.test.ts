import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface HistoryEntry {
  id: number;
  surface: string;
  prompt: string;
  params: Record<string, unknown> | null;
  created_at: number;
}

function parseText<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text) as T;
}

async function createProject(client: Client, slug: string) {
  await client.callTool({
    name: "create_project",
    arguments: { project_slug: slug },
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
    arguments: { project_slug: slug, surface, prompt, params },
  });
}

async function list(client: Client, slug: string, surface: string, limit?: number) {
  const result = await client.callTool({
    name: "list_prompt_history",
    arguments: { project_slug: slug, surface, ...(limit ? { limit } : {}) },
  });
  return parseText<{ entries: HistoryEntry[] }>(result);
}

describe("prompt history tools", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
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
      arguments: { project_slug: "p", surface: "garbage" },
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

  it("imports legacy chat-input-history.jsonl on first list of surface=chat", async () => {
    client = await createTestClient(tempDir);
    await createProject(client, "p");
    // Seed legacy log via push_chat_history (which writes JSONL).
    await client.callTool({
      name: "push_chat_history",
      arguments: { project_slug: "p", message: "legacy one" },
    });
    await client.callTool({
      name: "push_chat_history",
      arguments: { project_slug: "p", message: "legacy two" },
    });

    const data = await list(client, "p", "chat");
    expect(data.entries.map((e) => e.prompt)).toEqual([
      "legacy two",
      "legacy one",
    ]);

    // A second list should NOT re-import (count > 0 now).
    await record(client, "p", "chat", "new entry");
    const second = await list(client, "p", "chat");
    expect(second.entries.map((e) => e.prompt)).toEqual([
      "new entry",
      "legacy two",
      "legacy one",
    ]);
  });

  it("record on nonexistent project returns error", async () => {
    client = await createTestClient(tempDir);
    const result = await record(client, "no-such", "chat", "hi");
    expect(result.isError).toBe(true);
  });
});
