import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";

const PROJECT = "test-proj";

async function callJson<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text) as T;
}

describe("set_character_voice tool", () => {
  let client: Client;
  let tempDir: string;
  let charAssetId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-char-voice-"));
    client = await createTestClient(tempDir);
    await client.callTool({ name: "create_project", arguments: { project_slug: PROJECT } });

    const fs = createFsForTest(tempDir);
    const created = await fs.createAsset("char", "narrator", PROJECT);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("setup: createAsset failed");
    charAssetId = created.value.assetId;

    const write = await fs.writeMetadata(
      charAssetId,
      "character",
      {
        subject_kind: "animal",
        other: "black cat with gold eyes",
        source_image_asset_id: "img-source",
        wardrobe: [],
        poses: [],
        outfits: [],
      },
      PROJECT,
    );
    expect(write.ok).toBe(true);
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("sets the ElevenLabs voice ID on a char-* asset profile", async () => {
    const result = await callJson<{ status: string; elevenlabs_voice_id: string }>(
      client,
      "set_character_voice",
      {
        project_slug: PROJECT,
        char_asset_id: charAssetId,
        elevenlabs_voice_id: "voice-custom-1",
      },
    );

    expect(result).toMatchObject({ status: "set", elevenlabs_voice_id: "voice-custom-1" });
    const read = await callJson<{ elevenlabs_voice_id?: string }>(client, "read_asset_metadata", {
      asset_id: charAssetId,
      name: "character",
      project_slug: PROJECT,
    });
    expect(read.elevenlabs_voice_id).toBe("voice-custom-1");
  });

  it("clears the ElevenLabs voice ID from a char-* asset profile", async () => {
    await callJson(client, "set_character_voice", {
      project_slug: PROJECT,
      char_asset_id: charAssetId,
      elevenlabs_voice_id: "voice-custom-1",
    });

    const result = await callJson<{ status: string; elevenlabs_voice_id: string | null }>(
      client,
      "set_character_voice",
      {
        project_slug: PROJECT,
        char_asset_id: charAssetId,
        elevenlabs_voice_id: "",
      },
    );

    expect(result).toMatchObject({ status: "cleared", elevenlabs_voice_id: null });
    const read = await callJson<{ elevenlabs_voice_id?: string }>(client, "read_asset_metadata", {
      asset_id: charAssetId,
      name: "character",
      project_slug: PROJECT,
    });
    expect(read.elevenlabs_voice_id).toBeUndefined();
  });
});
