import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { createTestClient } from "../test-client.js";

type TextContent = Array<{ type: string; text: string }>;

describe("insert_timeline_slot tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("accepts a capitalized slot and position and still refuses an empty slot", async () => {
    const result = await client.callTool({
      name: "insert_timeline_slot",
      arguments: { book_id: "test-proj", slot: "S02", position: "Before" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("Empty slots are not supported");
  });

  it("rejects inserting an empty slot before a typed slot", async () => {
    const result = await client.callTool({
      name: "insert_timeline_slot",
      arguments: { book_id: "test-proj", slot: "s02", position: "before" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("Empty slots are not supported");
  });

  it("rejects inserting an empty slot after a typed slot", async () => {
    const result = await client.callTool({
      name: "insert_timeline_slot",
      arguments: { book_id: "test-proj", slot: "s02", position: "after" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("use assign_slot");
  });

  it("rejects inserting through a displayed virtual slot", async () => {
    const result = await client.callTool({
      name: "insert_timeline_slot",
      arguments: { book_id: "test-proj", slot: "s03", position: "after" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("Empty slots are not supported");
  });

  it.each(["slot2", "s00"])("rejects invalid slot identifier %s", async (slot) => {
    const result = await client.callTool({
      name: "insert_timeline_slot",
      arguments: { book_id: "test-proj", slot, position: "before" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("Slot must use the form");
  });

  it("returns an error for a nonexistent project", async () => {
    const result = await client.callTool({
      name: "insert_timeline_slot",
      arguments: { book_id: "missing", slot: "s01", position: "after" },
    });

    expect(result.isError).toBe(true);
  });
});
