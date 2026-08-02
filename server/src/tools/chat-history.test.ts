import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/client";

function parseText(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

describe("chat history tools", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("list_chat_history on empty project returns empty messages array", async () => {
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
    const result = await client.callTool({
      name: "list_chat_history",
      arguments: { book_id: "test-proj" },
    });
    const data = parseText(result);
    expect(data).toEqual({ messages: [] });
  });

  it("push_chat_history then list_chat_history returns the message", async () => {
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
    const pushResult = await client.callTool({
      name: "push_chat_history",
      arguments: { message: "hello world", book_id: "test-proj" },
    });
    expect(parseText(pushResult)).toEqual({ ok: true });

    const listResult = await client.callTool({
      name: "list_chat_history",
      arguments: { book_id: "test-proj" },
    });
    const data = parseText(listResult);
    expect(data.messages).toEqual(["hello world"]);
  });

  it("multiple pushes, list returns all messages", async () => {
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
    await client.callTool({
      name: "push_chat_history",
      arguments: { message: "first", book_id: "test-proj" },
    });
    await client.callTool({
      name: "push_chat_history",
      arguments: { message: "second", book_id: "test-proj" },
    });
    await client.callTool({
      name: "push_chat_history",
      arguments: { message: "third", book_id: "test-proj" },
    });

    const result = await client.callTool({
      name: "list_chat_history",
      arguments: { book_id: "test-proj" },
    });
    const data = parseText(result) as { messages: string[] };
    expect(data.messages).toEqual(["first", "second", "third"]);
  });

  it("list with limit parameter returns only that many messages", async () => {
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
    await client.callTool({
      name: "push_chat_history",
      arguments: { message: "one", book_id: "test-proj" },
    });
    await client.callTool({
      name: "push_chat_history",
      arguments: { message: "two", book_id: "test-proj" },
    });
    await client.callTool({
      name: "push_chat_history",
      arguments: { message: "three", book_id: "test-proj" },
    });

    const result = await client.callTool({
      name: "list_chat_history",
      arguments: { book_id: "test-proj", limit: 2 },
    });
    const data = parseText(result) as { messages: string[] };
    expect(data.messages).toHaveLength(2);
  });

  it("push_chat_history on nonexistent project returns error", async () => {
    client = await createTestClient(tempDir);
    const result = await client.callTool({
      name: "push_chat_history",
      arguments: { message: "hello", book_id: "no-such-project" },
    });
    expect(result.isError).toBe(true);
  });
});
