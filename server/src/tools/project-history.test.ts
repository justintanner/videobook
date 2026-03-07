import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("project_history tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns commit history for a project", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data },
    });

    const result = await client.callTool({
      name: "project_history",
      arguments: { project_slug: "test-proj" },
    });

    const commits = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(Array.isArray(commits)).toBe(true);
    expect(commits.length).toBeGreaterThan(0);
    expect(commits[0]).toHaveProperty("hash");
    expect(commits[0]).toHaveProperty("message");
    expect(commits[0]).toHaveProperty("date");
  });

  it("respects limit parameter", async () => {
    const data = Buffer.from("fake-data").toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "a.png", data },
    });
    await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "b.png", data },
    });

    const result = await client.callTool({
      name: "project_history",
      arguments: { project_slug: "test-proj", limit: 1 },
    });

    const commits = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(commits.length).toBe(1);
  });
});
