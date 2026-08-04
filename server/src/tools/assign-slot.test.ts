import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../fs.js";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";

type TextContent = Array<{ type: string; text: string }>;

async function registerTestVideoStream(
  fs: Engine,
  artifactId: string,
): Promise<void> {
  const manifest = await fs.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = manifest.value.files.find((entry) => entry.name === "original.mp4");
  if (!file) throw new Error("Missing original.mp4");
  const registered = await fs.streams.register({
    artifactId,
    sourcePath: file.name,
    objectHash: file.objectHash,
    streamIndex: 0,
    kind: "video",
    timeBase: { numerator: 1, denominator: 1_000 },
    durationTicks: 1_000,
    codec: "h264",
    video: {
      width: 1920,
      height: 1080,
      rotationDegrees: 0,
      pixelAspect: { numerator: 1, denominator: 1 },
      nominalFrameRate: { numerator: 30, denominator: 1 },
    },
  });
  if (!registered.ok) throw new Error(registered.error.message);
}

describe("assign_slot tool", () => {
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
    // Upload an asset to use in slot assignments
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
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("assigns an asset to slot s01", async () => {
    const result = await client.callTool({
      name: "assign_slot",
      arguments: {
        book_id: "test-proj",
        asset_id: assetId,
        slot: "s01",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.slots).toBeDefined();
    expect(parsed.slots[0].artifact_id).toBe(artifactId);
  });

  it("rejects a higher slot that would create empty gaps", async () => {
    const result = await client.callTool({
      name: "assign_slot",
      arguments: {
        book_id: "test-proj",
        asset_id: assetId,
        slot: "s03",
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("cannot contain empty gaps");
  });

  it("preserves existing slots when assigning to a new one", async () => {
    // Assign to slot 1
    await client.callTool({
      name: "assign_slot",
      arguments: {
        book_id: "test-proj",
        asset_id: assetId,
        slot: "s01",
      },
    });

    // Upload a second asset
    const data2 = Buffer.from("fake-png-data-2").toString("base64");
    const upload2 = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "photo2.png", data: data2 },
    });
    const asset2 = JSON.parse((upload2.content as TextContent)[0].text);

    // Assign second asset to slot 2
    const result = await client.callTool({
      name: "assign_slot",
      arguments: {
        book_id: "test-proj",
        asset_id: asset2.assetId,
        slot: "s02",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.slots[0].artifact_id).toBe(artifactId);
    expect(parsed.slots[1].artifact_id).toBe(asset2.artifactId);
  });

  it("returns error for invalid slot format", async () => {
    const result = await client.callTool({
      name: "assign_slot",
      arguments: {
        book_id: "test-proj",
        asset_id: assetId,
        slot: "slot1",
      },
    });

    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Slot must use the form");
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "assign_slot",
      arguments: {
        book_id: "test-proj",
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
        book_id: "test-proj",
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
        book_id: "test-proj",
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
        book_id: "test-proj",
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
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
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
      arguments: { book_id: "test-proj", filename, data },
    });
    return JSON.parse((result.content as TextContent)[0].text).assetId;
  }

  it("enqueues describe_image when an unanalyzed img- is dropped into a slot", async () => {
    const assetId = await uploadImage("photo.png");

    const result = await client.callTool({
      name: "assign_slot",
      arguments: { book_id: "test-proj", asset_id: assetId, slot: "s01" },
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
      arguments: { book_id: "test-proj", asset_id: assetId, slot: "s01" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("no image source file");
  });

  it("does not enqueue analysis when OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const assetId = await uploadImage("photo.png");

    const result = await client.callTool({
      name: "assign_slot",
      arguments: { book_id: "test-proj", asset_id: assetId, slot: "s01" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.auto_analyze).toBeUndefined();
  });

  it("skips re-analysis when .original.analysis.json already exists", async () => {
    const assetId = await uploadImage("photo.png");

    // Drop the analysis sidecar in place by hand to simulate prior run.
    const fs = createEngineForTest(tempDir);
    const writeRes = await fs.files.write(assetId, ".original.analysis.json", Buffer.from(JSON.stringify({ summary: "" }))
    );
    if (!writeRes.ok) throw new Error(writeRes.error.message);

    const result = await client.callTool({
      name: "assign_slot",
      arguments: { book_id: "test-proj", asset_id: assetId, slot: "s01" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.auto_analyze).toBeUndefined();
  });

  it("enqueues analyze_video for an unanalyzed vid- dropped into a slot", async () => {
    const fs = createEngineForTest(tempDir);
    const created = await fs.artifacts.create("vid", "fake-clip");
    if (!created.ok) throw new Error(created.error.message);
    const assetId = created.value.artifactId;
    const written = await fs.files.write(created.value.artifactId, "original.mp4", "fake-video-data");
    if (!written.ok) throw new Error(written.error.message);
    await registerTestVideoStream(fs, created.value.artifactId);

    const result = await client.callTool({
      name: "assign_slot",
      arguments: { book_id: "test-proj", asset_id: assetId, slot: "s01" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as TextContent)[0].text);
    expect(parsed.auto_analyze).toBeDefined();
    expect(parsed.auto_analyze.kind).toBe("analyze_video");
    expect(typeof parsed.auto_analyze.jobId).toBe("string");
  });
});
