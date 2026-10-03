import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { findPrimaryMediaFile } from "videobook-engine";
import sharp from "sharp";
import { createEngineForTest } from "../engine.js";
import { createTestClient } from "../test-client.js";
import { queue, waitForJob } from "../queue.js";
import type { Client } from "@modelcontextprotocol/client";

// Minimal valid 1x1 red PNG (67 bytes)
const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

describe("upload_file tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: Engine;

  beforeAll(async () => {
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop();
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    fs = createEngineForTest(tempDir);
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

  it("uploads an image file", async () => {
    const data = MINIMAL_PNG.toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "test-proj",
        filename: "photo.png",
        data,
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    const artifact = fs.artifacts.get(parsed.assetId);
    expect(artifact.ok && artifact.value.kind).toBe("image");
    expect(parsed.filename).toBe("original.png");

    const written = await fs.files.read(parsed.assetId, "original.png");
    expect(written.ok && written.value.equals(MINIMAL_PNG)).toBe(true);
  });

  it("stores original metadata after media upload", async () => {
    const data = MINIMAL_PNG.toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "test-proj",
        filename: "photo.png",
        data,
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);

    const origin = await fs.metadata.artifacts.read<{
      origin: string;
      processed_at: string;
    }>(parsed.assetId, "original");
    expect(origin.ok && origin.value.origin).toBe("upload");
    expect(origin.ok && origin.value.processed_at).toBeDefined();
  });

  it.each(["HEIC", "heif"])("decodes a %s photo, preserving its source and full portrait preview", async (extension) => {
    const source = await readFile(new URL("../../../tests/fixtures/images/portrait.heic", import.meta.url));
    const result = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: `photo.${extension}`, data: source.toString("base64") },
    });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const uploaded = JSON.parse(content[0].text) as { assetId: string; filename: string; processingError?: string };
    expect(uploaded.processingError).toBeUndefined();
    expect(uploaded.filename).toBe(`original.${extension.toLowerCase()}`);
    const original = await fs.files.read(uploaded.assetId, uploaded.filename);
    expect(original.ok && original.value.equals(source)).toBe(true);

    const preview = await fs.files.read(uploaded.assetId, "original.png");
    if (!preview.ok) throw new Error(preview.error.message);
    const { data, info } = await sharp(preview.value).raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 64, height: 96, channels: 4 });
    const top = (16 * info.width + 32) * info.channels;
    const bottom = (80 * info.width + 32) * info.channels;
    expect(data[top]).toBeGreaterThan(240);
    expect(data[top + 2]).toBeLessThan(10);
    expect(data[bottom]).toBeLessThan(10);
    expect(data[bottom + 2]).toBeGreaterThan(240);

    const metadata = await fs.metadata.artifacts.read(uploaded.assetId, "original");
    expect(metadata.ok && metadata.value).toMatchObject({ width: 64, height: 96, origin: "upload" });
    const manifest = await fs.files.manifest(uploaded.assetId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    expect(findPrimaryMediaFile(manifest.value.files, "image")?.name).toBe("original.png");
    for (const [name, width, height] of [["landscape", 1920, 1080], ["portrait", 1080, 1920], ["square", 1080, 1080]] as const) {
      const variant = await fs.files.read(uploaded.assetId, `${name}.jpg`);
      if (!variant.ok) throw new Error(variant.error.message);
      expect(await sharp(variant.value).metadata()).toMatchObject({ format: "jpeg", width, height });
    }
  });

  it("reports a failed HEIC decode and retries from its retained source", async () => {
    const source = Buffer.from("invalid HEIC image");
    const result = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "broken.heic", data: source.toString("base64") },
    });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const uploaded = JSON.parse(content[0].text) as { assetId: string; processingError?: string };
    expect(uploaded.processingError).toMatch(/HEIC/i);
    const retained = await fs.files.read(uploaded.assetId, "original.heic");
    expect(retained.ok && retained.value.equals(source)).toBe(true);
    expect((await fs.files.read(uploaded.assetId, "original.png")).ok).toBe(false);

    const repaired = await readFile(new URL("../../../tests/fixtures/images/portrait.heic", import.meta.url));
    const written = await fs.files.write(uploaded.assetId, "original.heic", repaired);
    expect(written.ok).toBe(true);
    const retry = await client.callTool({
      name: "retry_ingest",
      arguments: { book_id: "test-proj", artifact_id: uploaded.assetId },
    });
    expect(retry.isError).not.toBe(true);
    const retryContent = retry.content as Array<{ type: string; text: string }>;
    const queued = JSON.parse(retryContent[0].text) as { requestId: string };
    await waitForJob(queued.requestId);
    const preview = await fs.files.read(uploaded.assetId, "original.png");
    if (!preview.ok) throw new Error(preview.error.message);
    expect(await sharp(preview.value).metadata()).toMatchObject({ width: 64, height: 96 });

    const edited = await sharp({ create: { width: 32, height: 32, channels: 3, background: "green" } }).png().toBuffer();
    expect((await fs.files.write(uploaded.assetId, "original.png", edited)).ok).toBe(true);
    const retried = await client.callTool({
      name: "retry_ingest",
      arguments: { book_id: "test-proj", artifact_id: uploaded.assetId },
    });
    expect(retried.isError).not.toBe(true);
    const retriedContent = retried.content as Array<{ type: string; text: string }>;
    const requeued = JSON.parse(retriedContent[0].text) as { requestId: string };
    await waitForJob(requeued.requestId);
    const preserved = await fs.files.read(uploaded.assetId, "original.png");
    expect(preserved.ok && preserved.value.equals(edited)).toBe(true);
  });

  it("uploads a markdown file", async () => {
    const data = Buffer.from("# Hello").toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "test-proj",
        filename: "script.md",
        data,
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    const artifact = fs.artifacts.get(parsed.assetId);
    expect(artifact.ok && artifact.value.kind).toBe("script");
  });

  it("rejects unsupported extension", async () => {
    const data = Buffer.from("hello").toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "test-proj",
        filename: "notes.txt",
        data,
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain(".txt");
  });

  it("rejects nonexistent project", async () => {
    const data = Buffer.from("data").toString("base64");
    const result = await client.callTool({
      name: "upload_file",
      arguments: {
        book_id: "no-such-project",
        filename: "photo.png",
        data,
      },
    });
    expect(result.isError).toBe(true);
  });
});
