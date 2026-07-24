import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("create_project tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("creates a project with explicit slug", async () => {
    client = await createTestClient(tempDir);
    const result = await client.callTool({
      name: "create_project",
      arguments: { book_id: "my-project" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.slug).toBe("my-project");
    expect(data.isDefault).toBe(true);
  });

  it("seeds a readable timeline on success", async () => {
    client = await createTestClient(tempDir);
    const created = await client.callTool({
      name: "create_project",
      arguments: { book_id: "seeded" },
    });
    expect(created.isError).toBeFalsy();

    const timeline = await client.callTool({
      name: "get_timeline",
      arguments: { book_id: "seeded" },
    });
    expect(timeline.isError).toBeFalsy();
    const content = timeline.content as Array<{ type: string; text: string }>;
    const config = JSON.parse(content[0].text);
    expect(config.slots).toEqual([]);
    expect(config.render).toBe("landscape");
  });

  it("returns error for duplicate slug", async () => {
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "dup" },
    });
    const result = await client.callTool({
      name: "create_project",
      arguments: { book_id: "dup" },
    });
    expect(result.isError).toBe(true);
  });
});
