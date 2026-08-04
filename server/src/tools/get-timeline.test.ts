import type { Client } from "@modelcontextprotocol/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestClient } from "../test-client.js";

type TextContent = Array<{ type: string; text: string }>;

describe("get_timeline tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-get-timeline-"));
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

  async function upload(name: string): Promise<{ artifactId: string }> {
    const result = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "test-proj",
        filename: `${name}.png`,
        data: Buffer.from(name).toString("base64"),
      },
    });
    return JSON.parse((result.content as TextContent)[0].text) as { artifactId: string };
  }

  it("returns an empty canonical timeline for a new book", async () => {
    const result = await client.callTool({
      name: "get_timeline",
      arguments: { book_id: "test-proj" },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as TextContent)[0].text);
    expect(data).toMatchObject({ slots: [], audio: [], render: "landscape" });
    expect(data.book_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns stable artifact references after set_timeline", async () => {
    const intro = await upload("intro");
    const outro = await upload("outro");
    await client.callTool({
      name: "set_timeline",
      arguments: {
        book_id: "test-proj",
        render: "portrait",
        slots: [
          { artifact_id: intro.artifactId, volume: 80 },
          { artifact_id: outro.artifactId, audioFadeOut: 0.5 },
        ],
      },
    });

    const result = await client.callTool({
      name: "get_timeline",
      arguments: { book_id: "test-proj" },
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as TextContent)[0].text);
    expect(data.render).toBe("portrait");
    expect(data.slots).toEqual([
      expect.objectContaining({ artifact_id: intro.artifactId, volume: 80 }),
      expect.objectContaining({ artifact_id: outro.artifactId, audioFadeOut: 0.5 }),
    ]);
  });

  it("round-trips a square canvas with an empty timeline", async () => {
    await client.callTool({
      name: "set_timeline",
      arguments: { book_id: "test-proj", render: "square", slots: [], audio: [] },
    });
    const result = await client.callTool({
      name: "get_timeline",
      arguments: { book_id: "test-proj" },
    });
    const data = JSON.parse((result.content as TextContent)[0].text);
    expect(data).toMatchObject({ slots: [], audio: [], render: "square" });
  });
});
