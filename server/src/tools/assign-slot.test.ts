import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";
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

describe("assign_slot lazy analysis trigger", () => {
  let client: Client;
  let tempDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
    savedKey = process.env.OPENAI_API_KEY;
    // "test-" prefix is rejected by api-key.ts so any accidentally-dequeued job
// fails closed before hitting the real provider.
process.env.OPENAI_API_KEY = "test-key";
  });

  afterEach(async () => {
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
    else delete process.env.OPENAI_API_KEY;
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  type TextContent = Array<{ type: string; text: string }>;

  async function uploadImage(filename: string): Promise<string> {
    const data = Buffer.from("fake-image-data").toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename, data },
    });
    return JSON.parse((result.content as TextContent)[0].text).assetId;
  }

  it("enqueues describe_image when an unanalyzed img- is dropped into a slot", async () => {
    const assetId = await uploadImage("photo.png");

    const result = await client.callTool({
      name: "assign_slot",
      arguments: { project_slug: "test-proj", asset_id: assetId, slot: "s01" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.auto_analyze).toBeDefined();
    expect(parsed.auto_analyze.kind).toBe("describe_image");
    expect(typeof parsed.auto_analyze.jobId).toBe("string");
  });

  it("does not enqueue describe_image for svg uploads (vision unreliable on vector)", async () => {
    const assetId = await uploadImage("logo.svg");

    const result = await client.callTool({
      name: "assign_slot",
      arguments: { project_slug: "test-proj", asset_id: assetId, slot: "s01" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.auto_analyze).toBeUndefined();
  });

  it("does not enqueue analysis when OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const assetId = await uploadImage("photo.png");

    const result = await client.callTool({
      name: "assign_slot",
      arguments: { project_slug: "test-proj", asset_id: assetId, slot: "s01" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.auto_analyze).toBeUndefined();
  });

  it("skips re-analysis when .original.analysis.json already exists", async () => {
    const assetId = await uploadImage("photo.png");

    // Drop the analysis sidecar in place by hand to simulate prior run.
    const fs = createFsForTest(tempDir);
    const writeRes = await fs.writeFile(
      assetId,
      ".original.analysis.json",
      Buffer.from(JSON.stringify({ summary: "" })),
      "test-proj",
    );
    if (!writeRes.ok) throw new Error(writeRes.error.message);

    const result = await client.callTool({
      name: "assign_slot",
      arguments: { project_slug: "test-proj", asset_id: assetId, slot: "s01" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.auto_analyze).toBeUndefined();
  });

  it("enqueues analyze_video for an unanalyzed vid- dropped into a slot", async () => {
    const fs = createFsForTest(tempDir);
    const created = await fs.createAsset("vid", "fake-clip", "test-proj");
    if (!created.ok) throw new Error(created.error.message);
    const assetId = created.value.assetId;
    await writeFile(join(created.value.path, "original.mp4"), "fake-video-data");

    const result = await client.callTool({
      name: "assign_slot",
      arguments: { project_slug: "test-proj", asset_id: assetId, slot: "s01" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.auto_analyze).toBeDefined();
    expect(parsed.auto_analyze.kind).toBe("analyze_video");
    expect(typeof parsed.auto_analyze.jobId).toBe("string");
  });
});
