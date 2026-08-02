import { createEngineForTest } from "../fs.js";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/client";

describe("rename_asset tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
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

  it("renames an existing asset", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as Array<{ type: string; text: string }>)[0].text
    );

    // Wait for the auto-enqueued process_image job to settle. fake-png-data
    // is not a real PNG so the handler errors out — the rename gate refuses
    // while status='working', so we poll until the lease releases.
    const deadline = Date.now() + 5000;
    let result: Awaited<ReturnType<typeof client.callTool>> | null = null;
    while (Date.now() < deadline) {
      result = await client.callTool({
        name: "rename_asset",
        arguments: {
          asset_id: uploaded.assetId,
          new_name: "sunset beach",
          book_id: "test-proj",
        },
      });
      if (!result.isError) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!result) throw new Error("rename never attempted");

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(parsed.old_asset_id).toBe(uploaded.assetId);
    expect(parsed.new_asset_id).toMatch(/^img-/);
    expect(parsed.new_asset_id).not.toBe(uploaded.assetId);

    // Slugs are active names, not aliases. The old name becomes available
    // immediately while the artifact keeps its stable UUID.
    const oldManifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: uploaded.assetId, book_id: "test-proj" },
    });
    expect(oldManifest.isError).toBe(true);

    // New asset should exist
    const newManifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.new_asset_id, book_id: "test-proj" },
    });
    const newParsed = JSON.parse(
      (newManifest.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(newParsed.slug).toBe(parsed.new_asset_id);
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "rename_asset",
      arguments: {
        asset_id: "img-no-such-asset",
        new_name: "whatever",
        book_id: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
  });

  it("keeps media and waveform on the same stable artifact identity", async () => {
    const fs = createEngineForTest(tempDir);
    const created = await fs.artifacts.create("aud", "old track");
    if (!created.ok) throw new Error(created.error.message);
    const sourceId = created.value.slug;
    const stableArtifactId = created.value.artifactId;
    const audio = Buffer.from("fake-mp3-audio");
    const write = await fs.files.write(sourceId, "original.mp3", audio);
    if (!write.ok) throw new Error(write.error.message);
    const waveform = await fs.metadata.waveforms.write(sourceId, [0.1, 0.8, 0.3]);
    if (!waveform.ok) throw new Error(waveform.error.message);

    const result = await client.callTool({
      name: "rename_asset",
      arguments: {
        asset_id: sourceId,
        new_name: "new track",
        book_id: "test-proj",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    ) as { new_asset_id: string };

    const renamedAudio = await fs.files.read(parsed.new_asset_id, "original.mp3");
    expect(renamedAudio.ok).toBe(true);
    if (renamedAudio.ok) expect(renamedAudio.value).toEqual(audio);
    const assets = fs.artifacts.list();
    expect(assets.map((asset) => asset.slug)).not.toContain(sourceId);
    expect(assets.map((asset) => asset.slug)).toContain(parsed.new_asset_id);
    const oldManifest = await fs.files.manifest(sourceId);
    const newManifest = await fs.files.manifest(parsed.new_asset_id);
    expect(oldManifest.ok).toBe(false);
    expect(newManifest.ok).toBe(true);
    const renamed = fs.artifacts.get("test-proj");
    expect(renamed.ok).toBe(true);
    if (renamed.ok) expect(renamed.value.artifactId).toBe(stableArtifactId);
    const renamedWaveform = await fs.metadata.waveforms.read(parsed.new_asset_id);
    expect(renamedWaveform.ok).toBe(true);
    if (renamedWaveform.ok) expect(renamedWaveform.value.peaks).toEqual([0.1, 0.8, 0.3]);
  });
});
