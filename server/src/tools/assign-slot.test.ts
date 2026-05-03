import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

describe("assign_slot tool", () => {
  let client: Client;
  let tempDir: string;
  let assetId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
    // Upload an asset to use in slot assignments
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as TextContent)[0].text,
    );
    assetId = uploaded.assetId;
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("assigns an asset to slot s01", async () => {
    const result = await client.callTool({
      name: "assign_slot",
      arguments: {
        project_slug: "test-proj",
        asset_id: assetId,
        slot: "s01",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.slots).toBeDefined();
    expect(parsed.slots[0].slug).toBe(assetId);
  });

  it("assigns to a higher slot, padding with empty slots", async () => {
    const result = await client.callTool({
      name: "assign_slot",
      arguments: {
        project_slug: "test-proj",
        asset_id: assetId,
        slot: "s03",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.slots).toHaveLength(3);
    expect(parsed.slots[0].slug).toBe("");
    expect(parsed.slots[1].slug).toBe("");
    expect(parsed.slots[2].slug).toBe(assetId);
  });

  it("preserves existing slots when assigning to a new one", async () => {
    // Assign to slot 1
    await client.callTool({
      name: "assign_slot",
      arguments: {
        project_slug: "test-proj",
        asset_id: assetId,
        slot: "s01",
      },
    });

    // Upload a second asset
    const data2 = Buffer.from("fake-png-data-2").toString("base64");
    const upload2 = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo2.png", data: data2 },
    });
    const asset2 = JSON.parse((upload2.content as TextContent)[0].text);

    // Assign second asset to slot 2
    const result = await client.callTool({
      name: "assign_slot",
      arguments: {
        project_slug: "test-proj",
        asset_id: asset2.assetId,
        slot: "s02",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.slots[0].slug).toBe(assetId);
    expect(parsed.slots[1].slug).toBe(asset2.assetId);
  });

  it("returns error for invalid slot format", async () => {
    const result = await client.callTool({
      name: "assign_slot",
      arguments: {
        project_slug: "test-proj",
        asset_id: assetId,
        slot: "slot1",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Invalid slot format");
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "assign_slot",
      arguments: {
        project_slug: "test-proj",
        asset_id: "img-no-such-asset",
        slot: "s01",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("not found");
  });

  it("returns error for slot s00 (zero index)", async () => {
    const result = await client.callTool({
      name: "assign_slot",
      arguments: {
        project_slug: "test-proj",
        asset_id: assetId,
        slot: "s00",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("sets render orientation to landscape by default", async () => {
    const result = await client.callTool({
      name: "assign_slot",
      arguments: {
        project_slug: "test-proj",
        asset_id: assetId,
        slot: "s01",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.render).toBe("landscape");
  });

  it("does not enqueue auto_render for non-vid assets", async () => {
    // assetId here is an img- asset (uploaded photo.png). Assigning it must
    // never trigger a render — only vid- assets are eligible for lazy render
    // on slot drop.
    const result = await client.callTool({
      name: "assign_slot",
      arguments: {
        project_slug: "test-proj",
        asset_id: assetId,
        slot: "s01",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.auto_render).toBeUndefined();
  });
});
