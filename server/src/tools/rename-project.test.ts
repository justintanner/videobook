import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/client";

describe("rename_project tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "original" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("renames an existing project", async () => {
    const result = await client.callTool({
      name: "rename_project",
      arguments: { old_slug: "original", new_slug: "renamed" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.slug).toBe("renamed");
    expect(data.bookId).toBeTruthy();
  });

  it("old slug not found and new slug works after rename", async () => {
    await client.callTool({
      name: "rename_project",
      arguments: { old_slug: "original", new_slug: "renamed" },
    });

    // Old slug should fail
    await client.callTool({
      name: "list_assets",
      arguments: { book_id: "original" },
    });
    // listAssets on nonexistent project returns empty or error
    // Let's check via switch_project which explicitly errors on missing
    const switchOld = await client.callTool({
      name: "switch_project",
      arguments: { book_id: "original" },
    });
    expect(switchOld.isError).toBe(true);

    // New slug should work
    const switchNew = await client.callTool({
      name: "switch_project",
      arguments: { book_id: "renamed" },
    });
    expect(switchNew.isError).toBeFalsy();
  });

  it("returns error for nonexistent project", async () => {
    const result = await client.callTool({
      name: "rename_project",
      arguments: { old_slug: "no-such-project", new_slug: "whatever" },
    });
    expect(result.isError).toBe(true);
  });
});
