import { describe, it, expect, afterEach } from "vitest";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("hello_world tool", () => {
  let client: Client;

  afterEach(async () => {
    await client?.close();
  });

  it("greets the given name", async () => {
    client = await createTestClient();
    const result = await client.callTool({
      name: "hello_world",
      arguments: { name: "Alice" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe("Hello, Alice! Welcome to Clipfirst.");
  });
});
