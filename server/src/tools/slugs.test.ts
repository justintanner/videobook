import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("slugs tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns empty array when no projects exist", async () => {
    client = await createTestClient(tempDir);
    const result = await client.callTool({
      name: "slugs",
      arguments: {},
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data).toEqual({ slugs: [] });
  });

  it("returns only slugs for all projects", async () => {
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "alpha" },
    });
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "beta" },
    });
    const result = await client.callTool({
      name: "slugs",
      arguments: {},
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.slugs.sort()).toEqual(["alpha", "beta"]);
  });
});
