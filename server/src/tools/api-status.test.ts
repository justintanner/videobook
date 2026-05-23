import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { queue } from "../queue.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

describe("api_status tool", () => {
  let client: Client;
  let tempDir: string;
  const originalKey = process.env.KIMI_CODING_API_KEY;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-api-status-test-"));
    client = await createTestClient(tempDir);
  });

  afterEach(async () => {
    if (originalKey) {
      process.env.KIMI_CODING_API_KEY = originalKey;
    } else {
      delete process.env.KIMI_CODING_API_KEY;
    }
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error when KIMI_CODING_API_KEY is not set", async () => {
    delete process.env.KIMI_CODING_API_KEY;

    const result = await client.callTool({
      name: "api_status",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("not set");
  });

  it("rejects placeholder KIMI_CODING_API_KEY without calling the API", async () => {
    process.env.KIMI_CODING_API_KEY = "test-key-placeholder";

    const result = await client.callTool({
      name: "api_status",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("placeholder");
  });
});
