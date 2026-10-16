import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/client";

type TextContent = Array<{ type: string; text: string }>;

describe("remove_timeline_slot slot validation", () => {
  let client: Client;
  let tempDir: string;
  let assetId: string;
  let artifactId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
    // Upload an asset and assign to slot 1
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as TextContent)[0].text,
    );
    assetId = uploaded.assetId;
    artifactId = uploaded.artifactId;
    await client.callTool({
      name: "assign_slot",
      arguments: {
        book_id: "test-proj",
        asset_id: assetId,
        slot: "s01",
      },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("clears an assigned slot", async () => {
    const result = await client.callTool({
      name: "remove_timeline_slot",
      arguments: {
        book_id: "test-proj",
        slot: "s01",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.slots).toEqual([]);
    expect(parsed.removed_artifact_id).toBe(artifactId);
  });

  it("preserves other slots when clearing one", async () => {
    // Add a second asset to slot 2
    const data2 = Buffer.from("fake-png-data-2").toString("base64");
    const upload2 = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "photo2.png", data: data2 },
    });
    const asset2 = JSON.parse((upload2.content as TextContent)[0].text);
    await client.callTool({
      name: "assign_slot",
      arguments: {
        book_id: "test-proj",
        asset_id: asset2.assetId,
        slot: "s02",
      },
    });

    // Clear slot 1
    const result = await client.callTool({
      name: "remove_timeline_slot",
      arguments: {
        book_id: "test-proj",
        slot: "s01",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.slots).toEqual([
      expect.objectContaining({ artifact_id: asset2.artifactId }),
    ]);
  });

  it("returns error for invalid slot format", async () => {
    const result = await client.callTool({
      name: "remove_timeline_slot",
      arguments: {
        book_id: "test-proj",
        slot: "invalid",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Slot must use the form");
  });

  it("returns error after all slots are removed", async () => {
    await client.callTool({
      name: "remove_timeline_slot",
      arguments: { book_id: "test-proj", slot: "s01" },
    });

    const result = await client.callTool({
      name: "remove_timeline_slot",
      arguments: {
        book_id: "test-proj",
        slot: "s01",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("outside the current timeline");
  });

  it("returns error for out-of-range slot index", async () => {
    // Timeline only has 1 slot (s01)
    const result = await client.callTool({
      name: "remove_timeline_slot",
      arguments: {
        book_id: "test-proj",
        slot: "s05",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("outside the current timeline");
  });

  it("returns error for slot s00", async () => {
    const result = await client.callTool({
      name: "remove_timeline_slot",
      arguments: {
        book_id: "test-proj",
        slot: "s00",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("rejects clearing an already-removed slot", async () => {
    await client.callTool({
      name: "remove_timeline_slot",
      arguments: { book_id: "test-proj", slot: "s01" },
    });

    const result = await client.callTool({
      name: "remove_timeline_slot",
      arguments: { book_id: "test-proj", slot: "s01" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("outside the current timeline");
  });
});
