import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

describe("clear_slot tool", () => {
  let client: Client;
  let tempDir: string;
  let assetId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
    // Upload an asset and assign to slot 1
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as TextContent)[0].text,
    );
    assetId = uploaded.assetId;
    await client.callTool({
      name: "assign_slot",
      arguments: {
        project_slug: "test-proj",
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
      name: "unassign_slot",
      arguments: {
        project_slug: "test-proj",
        slot: "s01",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.slots[0].slug).toBe("");
  });

  it("preserves other slots when clearing one", async () => {
    // Add a second asset to slot 2
    const data2 = Buffer.from("fake-png-data-2").toString("base64");
    const upload2 = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo2.png", data: data2 },
    });
    const asset2 = JSON.parse((upload2.content as TextContent)[0].text);
    await client.callTool({
      name: "assign_slot",
      arguments: {
        project_slug: "test-proj",
        asset_id: asset2.assetId,
        slot: "s02",
      },
    });

    // Clear slot 1
    const result = await client.callTool({
      name: "unassign_slot",
      arguments: {
        project_slug: "test-proj",
        slot: "s01",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.slots[0].slug).toBe("");
    expect(parsed.slots[1].slug).toBe(asset2.assetId);
  });

  it("returns error for invalid slot format", async () => {
    const result = await client.callTool({
      name: "unassign_slot",
      arguments: {
        project_slug: "test-proj",
        slot: "invalid",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Invalid slot format");
  });

  it("returns error when project has no slots assigned", async () => {
    // Create a fresh project with no timeline slots
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "empty-proj" },
    });

    const result = await client.callTool({
      name: "unassign_slot",
      arguments: {
        project_slug: "empty-proj",
        slot: "s01",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    // Either "No timeline" or "out of range" depending on whether metadata exists
    expect(content[0].text).toMatch(/No timeline|out of range/);
  });

  it("returns error for out-of-range slot index", async () => {
    // Timeline only has 1 slot (s01)
    const result = await client.callTool({
      name: "unassign_slot",
      arguments: {
        project_slug: "test-proj",
        slot: "s05",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("out of range");
  });

  it("returns error for slot s00", async () => {
    const result = await client.callTool({
      name: "unassign_slot",
      arguments: {
        project_slug: "test-proj",
        slot: "s00",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("clearing already-empty slot resets volume/fade", async () => {
    // Clear slot 1 first
    await client.callTool({
      name: "unassign_slot",
      arguments: { project_slug: "test-proj", slot: "s01" },
    });

    // Clear it again (already empty)
    const result = await client.callTool({
      name: "unassign_slot",
      arguments: { project_slug: "test-proj", slot: "s01" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.slots[0].slug).toBe("");
    // Volume/fade fields should not exist since clear does a full reset
    expect(parsed.slots[0].volume).toBeUndefined();
  });
});
