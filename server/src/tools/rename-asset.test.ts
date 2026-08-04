import { createEngineForTest } from "../fs.js";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/client";

type TextContent = Array<{ type: string; text: string }>;

interface RenamePayload {
  artifact_id: string;
  label: string;
}

/** A well-formed artifact id that is never created in these fixtures. */
const MISSING_ARTIFACT_ID = "01890f1c-0000-7000-8000-0000000000aa";

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

  it("sets the display label of an existing asset", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "photo.png", data },
    });
    const uploaded = JSON.parse(
      (uploadResult.content as TextContent)[0].text,
    ) as { assetId: string; artifactId: string };

    const result = await client.callTool({
      name: "rename_asset",
      arguments: {
        asset_id: uploaded.artifactId,
        new_name: "sunset beach",
        book_id: "test-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(
      (result.content as TextContent)[0].text,
    ) as RenamePayload;
    expect(parsed.artifact_id).toBe(uploaded.artifactId);
    expect(parsed.label).toBe("sunset beach");

    // Labels are display-only: the artifact id is unchanged and still
    // addresses the same workspace.
    const manifest = await client.callTool({
      name: "asset_manifest",
      arguments: { asset_id: uploaded.artifactId, book_id: "test-proj" },
    });
    expect(manifest.isError).toBeFalsy();
    const manifestParsed = JSON.parse(
      (manifest.content as TextContent)[0].text,
    ) as { artifactId: string; label?: string };
    expect(manifestParsed.artifactId).toBe(uploaded.artifactId);
    expect(manifestParsed.label).toBe("sunset beach");
  });

  it("returns error for nonexistent asset", async () => {
    const result = await client.callTool({
      name: "rename_asset",
      arguments: {
        asset_id: MISSING_ARTIFACT_ID,
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
    const artifactId = created.value.artifactId;
    const audio = Buffer.from("fake-mp3-audio");
    const write = await fs.files.write(artifactId, "original.mp3", audio);
    if (!write.ok) throw new Error(write.error.message);
    const waveform = await fs.metadata.waveforms.write(artifactId, [0.1, 0.8, 0.3]);
    if (!waveform.ok) throw new Error(waveform.error.message);

    const result = await client.callTool({
      name: "rename_asset",
      arguments: {
        asset_id: artifactId,
        new_name: "new track",
        book_id: "test-proj",
      },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(
      (result.content as TextContent)[0].text,
    ) as RenamePayload;
    expect(parsed.artifact_id).toBe(artifactId);
    expect(parsed.label).toBe("new track");

    const renamedAudio = await fs.files.read(artifactId, "original.mp3");
    expect(renamedAudio.ok).toBe(true);
    if (renamedAudio.ok) expect(renamedAudio.value).toEqual(audio);

    const assets = fs.artifacts.list();
    expect(assets.map((asset) => asset.artifactId)).toContain(artifactId);
    const relabeled = assets.find((asset) => asset.artifactId === artifactId);
    expect(relabeled?.label).toBe("new track");

    const manifest = await fs.files.manifest(artifactId);
    expect(manifest.ok).toBe(true);
    if (manifest.ok) expect(manifest.value.label).toBe("new track");

    const renamedWaveform = await fs.metadata.waveforms.read(artifactId);
    expect(renamedWaveform.ok).toBe(true);
    if (renamedWaveform.ok) expect(renamedWaveform.value.peaks).toEqual([0.1, 0.8, 0.3]);
  });
});
