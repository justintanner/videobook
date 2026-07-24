import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestClient } from "../test-client.js";

type TextContent = Array<{ type: string; text: string }>;

const EMPTY_DEFINITION = { properties: {}, sequence: [] };
const NOTEBOOK_DEFINITION = {
  properties: { title: "Fox storyboard" },
  sequence: [{
    id: "prompt-1",
    componentType: "task",
    type: "prompt",
    name: "Idea",
    properties: { text: "A neon fox walks through a misted alley." },
  }],
};

function response(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as TextContent;
  return JSON.parse(content[0].text);
}

describe("read_notebook tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-read-notebook-"));
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

  it("reads a normalized notebook graph", async () => {
    const written = await client.callTool({
      name: "write_notebook",
      arguments: {
        book_id: "test-proj",
        name: "Storyboard",
        definition: NOTEBOOK_DEFINITION,
      },
    });
    const notebookId = response(written).notebook_id as string;

    const result = await client.callTool({
      name: "read_notebook",
      arguments: {
        book_id: "test-proj",
        notebook_id: notebookId,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(response(result)).toEqual({
      exists: true,
      definition: NOTEBOOK_DEFINITION,
    });
  });

  it("returns an empty definition for a missing notebook UUID", async () => {
    const result = await client.callTool({
      name: "read_notebook",
      arguments: {
        book_id: "test-proj",
        notebook_id: "01900000-0000-7000-8000-000000000000",
      },
    });

    expect(result.isError).toBeFalsy();
    expect(response(result)).toEqual({
      exists: false,
      definition: EMPTY_DEFINITION,
    });
  });

  it("returns an error when the project does not exist", async () => {
    const result = await client.callTool({
      name: "read_notebook",
      arguments: {
        book_id: "no-such-project",
        notebook_id: "01900000-0000-7000-8000-000000000000",
      },
    });
    expect(result.isError).toBe(true);
  });
});
