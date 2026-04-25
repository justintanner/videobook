import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

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

describe("pin_character_slot / unpin_character_slot tools", () => {
  let client: Client;
  let tempDir: string;
  let charAssetId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-pin-"));
    client = await createTestClient(tempDir);
    await client.callTool({ name: "create_project", arguments: { project_slug: PROJECT } });

    // Seed a char-* asset with an empty .character.json — bypass the vision
    // pipeline entirely; this tool's contract is purely metadata r/w.
    const fs = createFsForTest(tempDir);
    const created = await fs.createAsset("char", "emma-1", PROJECT);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("setup: createAsset failed");
    charAssetId = created.value.assetId;

    await fs.writeMetadata(
      charAssetId,
      "character",
      {
        age: "early-20s",
        gender_presentation: "feminine",
        ethnicity: "Mediterranean",
        height: "tall",
        build: "lean athletic",
        face: "oval",
        hair: "long curly dark brown",
        eyes: "hazel almond",
        skin: "olive",
        distinguishing_features: "gold hoops",
        source_image_asset_id: "img-source-1",
        wardrobe: [],
        poses: [],
        outfits: [],
      },
      PROJECT,
    );
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("pins an asset to wardrobe and persists to .character.json", async () => {
    const pin = await callJson<{ status: string; length: number }>(client, "pin_character_slot", {
      project_slug: PROJECT,
      char_asset_id: charAssetId,
      slot: "wardrobe",
      asset_id: "img-shirt-1",
    });
    expect(pin.status).toBe("pinned");
    expect(pin.length).toBe(1);

    const read = await callJson<{ wardrobe: string[]; poses: string[]; outfits: string[] }>(
      client,
      "read_asset_metadata",
      { asset_id: charAssetId, name: "character", project_slug: PROJECT },
    );
    expect(read.wardrobe).toEqual(["img-shirt-1"]);
    expect(read.poses).toEqual([]);
    expect(read.outfits).toEqual([]);
  });

  it("is idempotent (no duplicate pin)", async () => {
    await callJson(client, "pin_character_slot", {
      project_slug: PROJECT,
      char_asset_id: charAssetId,
      slot: "poses",
      asset_id: "img-pose-1",
    });
    const dup = await callJson<{ status: string; length: number }>(client, "pin_character_slot", {
      project_slug: PROJECT,
      char_asset_id: charAssetId,
      slot: "poses",
      asset_id: "img-pose-1",
    });
    expect(dup.status).toBe("already_pinned");
    expect(dup.length).toBe(1);
  });

  it("unpins an asset and persists removal", async () => {
    await callJson(client, "pin_character_slot", {
      project_slug: PROJECT,
      char_asset_id: charAssetId,
      slot: "outfits",
      asset_id: "img-outfit-a",
    });
    await callJson(client, "pin_character_slot", {
      project_slug: PROJECT,
      char_asset_id: charAssetId,
      slot: "outfits",
      asset_id: "img-outfit-b",
    });
    const unpin = await callJson<{ status: string; length: number }>(
      client,
      "unpin_character_slot",
      {
        project_slug: PROJECT,
        char_asset_id: charAssetId,
        slot: "outfits",
        asset_id: "img-outfit-a",
      },
    );
    expect(unpin.status).toBe("unpinned");
    expect(unpin.length).toBe(1);

    const read = await callJson<{ outfits: string[] }>(client, "read_asset_metadata", {
      asset_id: charAssetId,
      name: "character",
      project_slug: PROJECT,
    });
    expect(read.outfits).toEqual(["img-outfit-b"]);
  });

  it("unpin is no-op when asset is not pinned", async () => {
    const res = await callJson<{ status: string }>(client, "unpin_character_slot", {
      project_slug: PROJECT,
      char_asset_id: charAssetId,
      slot: "wardrobe",
      asset_id: "img-not-there",
    });
    expect(res.status).toBe("not_pinned");
  });

  it("rejects non-char- asset ids", async () => {
    const res = await client.callTool({
      name: "pin_character_slot",
      arguments: {
        project_slug: PROJECT,
        char_asset_id: "img-not-a-char",
        slot: "wardrobe",
        asset_id: "img-shirt",
      },
    });
    expect(res.isError).toBe(true);
  });

  it("strips leading @ from char_asset_id and asset_id", async () => {
    await callJson(client, "pin_character_slot", {
      project_slug: PROJECT,
      char_asset_id: `@${charAssetId}`,
      slot: "wardrobe",
      asset_id: "@img-shirt-2",
    });
    const read = await callJson<{ wardrobe: string[] }>(client, "read_asset_metadata", {
      asset_id: charAssetId,
      name: "character",
      project_slug: PROJECT,
    });
    expect(read.wardrobe).toEqual(["img-shirt-2"]);
  });
});
