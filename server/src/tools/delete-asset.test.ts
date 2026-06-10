import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("delete_asset tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("deletes an existing asset", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as Array<{ type: string; text: string }>)[0].text
    );

    const result = await client.callTool({
      name: "delete_asset",
      arguments: { asset_id: uploaded.assetId, project_slug: "test-proj" },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(parsed.status).toBe("deleted");
    expect(parsed.asset_id).toBe(uploaded.assetId);
    expect(parsed.deleted_at).toBeDefined();

    // Verify asset is gone via manifest
    const manifestResult = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: uploaded.assetId, project_slug: "test-proj" },
    });
    expect(manifestResult.isError).toBe(true);
  });

  it("clears timeline slots referencing the deleted asset", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as Array<{ type: string; text: string }>)[0].text
    ) as { assetId: string };

    const assignResult = await client.callTool({
      name: "assign_slot",
      arguments: { asset_id: uploaded.assetId, slot: "s01", project_slug: "test-proj" },
    });
    expect(assignResult.isError).toBeFalsy();

    const result = await client.callTool({
      name: "delete_asset",
      arguments: { asset_id: uploaded.assetId, project_slug: "test-proj" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(parsed.timeline).toEqual({ updated: true });

    const timelineResult = await client.callTool({
      name: "get_timeline",
      arguments: { project_slug: "test-proj" },
    });
    const timeline = JSON.parse(
      (timelineResult.content as Array<{ type: string; text: string }>)[0].text
    ) as { slots: Array<{ slug: string }> };
    expect(timeline.slots[0]?.slug).toBe("");
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "delete_asset",
      arguments: { asset_id: "img-no-such-asset", project_slug: "test-proj" },
    });
    expect(result.isError).toBe(true);
  });
});
