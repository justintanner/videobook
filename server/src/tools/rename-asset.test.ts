import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createFs } from "videobook-engine";

describe("rename_asset tool", () => {
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

  it("renames an existing asset", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "photo.png", data },
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
          project_slug: "test-proj",
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

    // Querying the old asset ID should now transparently return the new asset's manifest
    const oldManifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: uploaded.assetId, project_slug: "test-proj" },
    });
    expect(oldManifest.isError).toBeFalsy();
    const oldParsed = JSON.parse(
      (oldManifest.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(oldParsed.asset_id).toBe(uploaded.assetId);

    // New asset should exist
    const newManifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: parsed.new_asset_id, project_slug: "test-proj" },
    });
    const newParsed = JSON.parse(
      (newManifest.content as Array<{ type: string; text: string }>)[0].text
    );
    expect(newParsed.asset_id).toBe(parsed.new_asset_id);
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "rename_asset",
      arguments: {
        asset_id: "img-no-such-asset",
        new_name: "whatever",
        project_slug: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
  });

  it("moves ignored audio media, removes the ghost asset, and preserves its waveform", async () => {
    const fs = createFs({ projectsDir: tempDir });
    const created = await fs.createAsset("aud", "old track", "test-proj");
    if (!created.ok) throw new Error(created.error.message);
    const sourceId = created.value.assetId;
    const audio = Buffer.from("fake-mp3-audio");
    const write = await fs.writeFile(sourceId, "original.mp3", audio, "test-proj");
    if (!write.ok) throw new Error(write.error.message);
    const waveform = await fs.writeAudioWaveform(sourceId, [0.1, 0.8, 0.3], "test-proj");
    if (!waveform.ok) throw new Error(waveform.error.message);

    const result = await client.callTool({
      name: "rename_asset",
      arguments: {
        asset_id: sourceId,
        new_name: "new track",
        project_slug: "test-proj",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text
    ) as { new_asset_id: string };

    const renamedAudio = await fs.readFile(parsed.new_asset_id, "original.mp3", "test-proj");
    expect(renamedAudio.ok).toBe(true);
    if (renamedAudio.ok) expect(renamedAudio.value).toEqual(audio);
    const assets = await fs.listAssets("test-proj");
    expect(assets.map((asset) => asset.id)).not.toContain(sourceId);
    const oldAlias = await fs.getManifest(sourceId, "test-proj");
    const newManifest = await fs.getManifest(parsed.new_asset_id, "test-proj");
    expect(oldAlias.ok).toBe(true);
    expect(newManifest.ok).toBe(true);
    if (oldAlias.ok && newManifest.ok) expect(oldAlias.value.path).toBe(newManifest.value.path);
    const renamedWaveform = await fs.readAudioWaveform(parsed.new_asset_id, "test-proj");
    expect(renamedWaveform.ok).toBe(true);
    if (renamedWaveform.ok) expect(renamedWaveform.value.peaks).toEqual([0.1, 0.8, 0.3]);
    fs.close();
  });
});
