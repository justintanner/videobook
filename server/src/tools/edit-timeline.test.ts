import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("edit_timeline tool", () => {
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
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("sets timeline with slots and returns path", async () => {
    const result = await client.callTool({
      name: "edit_timeline",
      arguments: {
        project_slug: "test-proj",
        slots: [{ slug: "vid-intro" }, { slug: "vid-outro", volume: 0.5 }],
      },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.path).toBeTruthy();
    expect(data.path).toContain("test-proj");
  });

  it("sets timeline with slots and render orientations", async () => {
    const result = await client.callTool({
      name: "edit_timeline",
      arguments: {
        project_slug: "test-proj",
        slots: [{ slug: "vid-hero" }],
        render: ["landscape", "portrait"],
      },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.path).toBeTruthy();
  });

  it("returns error for nonexistent project", async () => {
    const result = await client.callTool({
      name: "edit_timeline",
      arguments: {
        project_slug: "no-such-project",
        slots: [{ slug: "vid-intro" }],
      },
    });
    expect(result.isError).toBe(true);
  });
});
