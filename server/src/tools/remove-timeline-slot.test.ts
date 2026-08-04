import type { Client } from "@modelcontextprotocol/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestClient } from "../test-client.js";

type TextContent = Array<{ type: string; text: string }>;
type UploadedAsset = { artifactId: string; assetId: string };

describe("remove_timeline_slot tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-remove-timeline-slot-"));
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

  async function assign(assetId: string, slot: string): Promise<void> {
    const result = await client.callTool({
      name: "assign_slot",
      arguments: { book_id: "test-proj", asset_id: assetId, slot },
    });
    expect(result.isError).toBeFalsy();
  }

  it("removes a filled slot and shifts later slots left", async () => {
    const first = await upload("first");
    const second = await upload("second");
    const third = await upload("third");
    await assign(first.assetId, "s01");
    await assign(second.assetId, "s02");
    await assign(third.assetId, "s03");

    const result = await client.callTool({
      name: "remove_timeline_slot",
      arguments: { book_id: "test-proj", slot: "s02" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.slots.map((slot: { artifact_id: string }) => slot.artifact_id)).toEqual([
      first.artifactId,
      third.artifactId,
    ]);
    expect(parsed.removed_artifact_id).toBe(second.artifactId);
  });

  it("removing the only stored slot leaves an empty timeline", async () => {
    const asset = await upload("only");
    await assign(asset.assetId, "s01");

    const result = await client.callTool({
      name: "remove_timeline_slot",
      arguments: { book_id: "test-proj", slot: "s01" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.slots).toEqual([]);
    expect(parsed.removed_artifact_id).toBe(asset.artifactId);
  });

  it.each(["slot2", "s00"])("rejects invalid slot identifier %s", async (slot) => {
    const result = await client.callTool({
      name: "remove_timeline_slot",
      arguments: { book_id: "test-proj", slot },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("Slot must use the form");
  });

  it("rejects slots outside the typed timeline and unknown books", async () => {
    const asset = await upload("first");
    await assign(asset.assetId, "s01");
    const outside = await client.callTool({
      name: "remove_timeline_slot",
      arguments: { book_id: "test-proj", slot: "s02" },
    });
    expect(outside.isError).toBe(true);
    expect((outside.content as TextContent)[0].text).toContain("outside the current timeline");

    const missing = await client.callTool({
      name: "remove_timeline_slot",
      arguments: { book_id: "missing", slot: "s01" },
    });
    expect(missing.isError).toBe(true);
  });
});
