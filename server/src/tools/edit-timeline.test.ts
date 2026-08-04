import type { Client } from "@modelcontextprotocol/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestClient } from "../test-client.js";

type TextContent = Array<{ type: string; text: string }>;
type UploadedAsset = { artifactId: string; assetId: string };

describe("set_timeline tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-set-timeline-"));
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

  async function upload(name: string): Promise<UploadedAsset> {
    const result = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "test-proj",
        filename: `${name}.png`,
        data: Buffer.from(name).toString("base64"),
      },
    });
    return JSON.parse((result.content as TextContent)[0].text) as UploadedAsset;
  }

  it("sets a dense timeline using stable artifact UUIDs", async () => {
    const intro = await upload("intro");
    const outro = await upload("outro");
    const result = await client.callTool({
      name: "set_timeline",
      arguments: {
        book_id: "test-proj",
        render: "landscape",
        slots: [
          { artifact_id: intro.artifactId },
          { artifact_id: outro.artifactId, volume: 50 },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as TextContent)[0].text);
    expect(data.book_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.slots.map((slot: { artifact_id: string }) => slot.artifact_id)).toEqual([
      intro.artifactId,
      outro.artifactId,
    ]);
    expect(data.slots[1].volume).toBe(50);
  });

  it("updates the canonical sequence canvas orientation", async () => {
    const asset = await upload("hero");
    const result = await client.callTool({
      name: "set_timeline",
      arguments: {
        book_id: "test-proj",
        render: "portrait",
        slots: [{ artifact_id: asset.artifactId }],
      },
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse((result.content as TextContent)[0].text);
    expect(data.render).toBe("portrait");
  });

  it("clears all slots when an explicit empty array is sent", async () => {
    const asset = await upload("hero");
    await client.callTool({
      name: "set_timeline",
      arguments: {
        book_id: "test-proj",
        render: "landscape",
        slots: [{ artifact_id: asset.artifactId }],
      },
    });
    const cleared = await client.callTool({
      name: "set_timeline",
      arguments: { book_id: "test-proj", render: "square", slots: [], audio: [] },
    });

    expect(cleared.isError).toBeFalsy();
    const data = JSON.parse((cleared.content as TextContent)[0].text);
    expect(data).toMatchObject({ render: "square", slots: [], audio: [] });
  });

  it("returns an error for an unknown book", async () => {
    const result = await client.callTool({
      name: "set_timeline",
      arguments: { book_id: "no-such-project", render: "landscape", slots: [] },
    });
    expect(result.isError).toBe(true);
  });
});
