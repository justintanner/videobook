import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("switch_project tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("switches to an existing project", async () => {
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "alpha" },
    });
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "beta" },
    });

    const result = await client.callTool({
      name: "switch_project",
      arguments: { project_slug: "alpha" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data).toEqual({ success: true });

    // Verify the default project is now alpha
    const defaultResult = await client.callTool({
      name: "ensure_default_project",
      arguments: {},
    });
    const defaultContent = defaultResult.content as Array<{ type: string; text: string }>;
    const defaultData = JSON.parse(defaultContent[0].text);
    expect(defaultData.metadata.slug).toBe("alpha");
  });

  it("returns error for nonexistent project", async () => {
    const result = await client.callTool({
      name: "switch_project",
      arguments: { project_slug: "no-such-project" },
    });
    expect(result.isError).toBe(true);
  });
});
