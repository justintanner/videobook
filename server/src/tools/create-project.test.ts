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
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates a project with auto-generated slug", async () => {
    client = await createTestClient(tempDir);
    const result = await client.callTool({
      name: "create_project",
      arguments: {},
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.slug).toBeTruthy();
    expect(data.path).toBeTruthy();
    expect(data.is_default).toBe(true);
  });

  it("creates a project with explicit slug", async () => {
    client = await createTestClient(tempDir);
    const result = await client.callTool({
      name: "create_project",
      arguments: { slug: "my-project" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.slug).toBe("my-project");
    expect(data.is_default).toBe(true);
  });

  it("returns error for duplicate slug", async () => {
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { slug: "dup" },
    });
    const result = await client.callTool({
      name: "create_project",
      arguments: { slug: "dup" },
    });
    expect(result.isError).toBe(true);
  });
});
