import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createEngineForTest } from "../engine.js";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";

describe("duplicate_asset tool", () => {
  let client: Client;
  let tempDir: string;
  let fs: Engine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    fs = createEngineForTest(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("duplicates an asset with same files", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as Array<{ type: string; text: string }>)[0].text
    );

    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: { asset_id: uploaded.assetId, book_id: "test-proj" },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(parsed.source_asset_id).toBe(uploaded.assetId);
    const copy = fs.artifacts.get(parsed.new_asset_id);
    expect(copy.ok && copy.value.kind).toBe("image");
    expect(parsed.new_asset_id).not.toBe(uploaded.assetId);

    // Verify copy has the same file
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.new_asset_id, book_id: "test-proj" },
    });
    const manifestParsed = JSON.parse(
      (manifest.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(manifestParsed.files.some((f: { name: string }) => f.name === "original.png")).toBe(true);
  });

  it("duplicates with a custom name", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as Array<{ type: string; text: string }>)[0].text
    );

    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: {
        asset_id: uploaded.assetId,
        book_id: "test-proj",
        new_name: "my custom copy",
      },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    const copy = fs.artifacts.get(parsed.new_asset_id);
    expect(copy.ok && copy.value.kind).toBe("image");
    expect(copy.ok && copy.value.label).toBe("my custom copy");
  });

  it("keeps a processed video duplicate ready", async () => {
    const source = await fs.artifacts.create("video", "ready source");
    if (!source.ok) throw new Error(source.error.message);
    await fs.files.write(source.value.artifactId, "original.mp4", "video-data");
    const sourceMetadata = {
      width: 1080,
      height: 1920,
      duration: 22.01,
      hasAudio: true,
    };
    const metadataWrite = await fs.metadata.artifacts.write(
      source.value.artifactId,
      "original",
      sourceMetadata,
    );
    if (!metadataWrite.ok) throw new Error(metadataWrite.error.message);

    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: {
        asset_id: source.value.artifactId,
        book_id: fs.book.get().bookId,
      },
    });
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    ) as { new_asset_id: string };
    const listResult = await client.callTool({
      name: "list_assets",
      arguments: { book_id: fs.book.get().bookId },
    });
    const listed = JSON.parse(
      (listResult.content as Array<{ type: string; text: string }>)[0].text,
    ) as { assets: Array<{ artifact_id: string; status: string }> };
    expect(listed.assets.find((asset) =>
      asset.artifact_id === parsed.new_asset_id)?.status).toBe("ready");
    const copiedMetadata = await fs.metadata.artifacts.read(
      parsed.new_asset_id,
      "original",
    );
    expect(copiedMetadata).toMatchObject({ ok: true, value: sourceMetadata });
  });

  it("places a notebook duplicate in an explicit destination cell", async () => {
    const source = await fs.artifacts.create("image", "source image");
    if (!source.ok) throw new Error(source.error.message);
    await fs.files.write(source.value.artifactId, "original.png", "image-data");
    const createdNotebook = await fs.notebooks.create("Main");
    if (!createdNotebook.ok) throw new Error(createdNotebook.error.message);
    const sourceCell = fs.notebooks.createCell({
      type: "image",
      slot: { row: 0, column: 0 },
      outputArtifactId: source.value.artifactId,
    });
    const written = await fs.notebooks.write({
      ...createdNotebook.value,
      cells: [sourceCell],
    });
    if (!written.ok) throw new Error(written.error.message);

    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: {
        asset_id: source.value.artifactId,
        book_id: fs.book.get().bookId,
        notebook_id: createdNotebook.value.id,
        destination: "BL8",
      },
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    ) as { address: string; cell_id: string; new_asset_id: string };
    expect(parsed.address).toBe("@bl8");
    const notebook = fs.notebooks.read(createdNotebook.value.id);
    if (!notebook.ok) throw new Error(notebook.error.message);
    expect(notebook.value.cells.find((cell) => cell.id === parsed.cell_id)).toMatchObject({
      type: "image",
      slot: { row: 63, column: 7 },
      outputArtifactId: parsed.new_asset_id,
    });
  });

  it("defaults a notebook duplicate to the neighboring cell below", async () => {
    const source = await fs.artifacts.create("video", "source video");
    if (!source.ok) throw new Error(source.error.message);
    await fs.files.write(source.value.artifactId, "original.mp4", "video-data");
    const createdNotebook = await fs.notebooks.create("Main");
    if (!createdNotebook.ok) throw new Error(createdNotebook.error.message);
    const sourceCell = fs.notebooks.createCell({
      type: "video",
      slot: { row: 4, column: 2 },
      outputArtifactId: source.value.artifactId,
    });
    const written = await fs.notebooks.write({
      ...createdNotebook.value,
      cells: [sourceCell],
    });
    if (!written.ok) throw new Error(written.error.message);

    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: {
        asset_id: source.value.artifactId,
        book_id: fs.book.get().bookId,
        notebook_id: createdNotebook.value.id,
      },
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    ) as { address: string };
    expect(parsed.address).toBe("@f3");
  });

  it("rejects an occupied default destination before copying the asset", async () => {
    const source = await fs.artifacts.create("audio", "source audio");
    if (!source.ok) throw new Error(source.error.message);
    const createdNotebook = await fs.notebooks.create("Main");
    if (!createdNotebook.ok) throw new Error(createdNotebook.error.message);
    const sourceCell = fs.notebooks.createCell({
      type: "audio",
      slot: { row: 0, column: 0 },
      outputArtifactId: source.value.artifactId,
    });
    const occupiedCell = fs.notebooks.createCell({
      type: "audio",
      slot: { row: 1, column: 0 },
    });
    const written = await fs.notebooks.write({
      ...createdNotebook.value,
      cells: [sourceCell, occupiedCell],
    });
    if (!written.ok) throw new Error(written.error.message);
    const artifactCount = fs.artifacts.list().length;

    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: {
        asset_id: source.value.artifactId,
        book_id: fs.book.get().bookId,
        notebook_id: createdNotebook.value.id,
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ type: string; text: string }>)[0].text)
      .toContain("Notebook cell @b1 is occupied");
    expect(fs.artifacts.list()).toHaveLength(artifactCount);
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: { asset_id: "img-no-such-asset", book_id: "test-proj" },
    });
    expect(result.isError).toBe(true);
  });

  it("video duplicate skips in-flight job markers", async () => {
    const created = await fs.artifacts.create("vid", "in-flight-source");
    if (!created.ok) throw new Error(created.error.message);
    const sourceId = created.value.artifactId;
    await fs.files.write(sourceId, "original.mp4", "fake");
    await fs.files.write(sourceId, ".kie-task.json", "{}");
    await fs.files.write(sourceId, ".generation-error.json", "{}");

    const result = await client.callTool({
      name: "duplicate_asset",
      arguments: { asset_id: sourceId, book_id: "test-proj" },
    });
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );
    const newId = parsed.new_asset_id as string;
    const newDir = join(tempDir, "test-proj", newId);
    await expect(access(join(newDir, ".kie-task.json"))).rejects.toThrow();
    await expect(access(join(newDir, ".generation-error.json"))).rejects.toThrow();
  });
});
