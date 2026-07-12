import { describe, it, expect } from "vitest";
import { createCharacterDef } from "./create-character.js";
import { setCharacterMetadataDef } from "./set-character-metadata.js";
import { createFs } from "videocity-engine";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import * as os from "node:os";

describe("Character lifecycle (create + metadata)", () => {
  it("creates a character and writes free-form metadata", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vc-char-test-"));
    const fs = createFs({ projectsDir: dir });
    const slug = "test-proj";
    await fs.createProject(slug);
    
    // Create
    const createTool = createCharacterDef(fs);
    const createResult = await createTool.handler({ project_slug: slug, args: ["bob"] }, {});
    expect(createResult.isError).toBeFalsy();
    const createdText = (createResult.content[0] as { type: "text", text: string }).text;
    const parsed = JSON.parse(createdText);
    expect(parsed.asset_id).toMatch(/^char-bob/);
    
    const charId = parsed.asset_id;
    
    // Set metadata
    const setTool = setCharacterMetadataDef(fs);
    const setResult = await setTool.handler({
      project_slug: slug,
      char_asset_id: charId,
      metadata: JSON.stringify({ age: 32, traits: ["brave", "tall"] })
    }, {});
    expect(setResult.isError).toBeFalsy();
    
    // Verify metadata
    const read = await fs.readMetadata(charId, "character", slug);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toMatchObject({ age: 32, traits: ["brave", "tall"] });
    }
  });

  it("creates a character seeded from one or more existing image assets", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vc-char-test-asset-"));
    const fs = createFs({ projectsDir: dir });
    const slug = "test-proj";
    await fs.createProject(slug);

    // Create dummy image assets to serve as sources
    const faceAsset = await fs.createAsset("img", "face", slug);
    const bodyAsset = await fs.createAsset("img", "body", slug);
    expect(faceAsset.ok).toBe(true);
    expect(bodyAsset.ok).toBe(true);
    if (faceAsset.ok) {
        await fs.writeFile(faceAsset.value.assetId, "original.png", "fake data", slug);
    }
    if (bodyAsset.ok) {
        await fs.writeFile(bodyAsset.value.assetId, "original.png", "fake data", slug);
    }

    const createTool = createCharacterDef(fs);

    // Test with one image and explicit name
    const createRes1 = await createTool.handler({ project_slug: slug, args: ["img-face", "alice"] }, {});
    expect(createRes1.isError).toBeFalsy();
    const parsed1 = JSON.parse((createRes1.content[0] as { type: "text", text: string }).text);
    expect(parsed1.asset_id).toMatch(/^char-alice/);

    // Test with multiple images and no explicit name
    const createRes2 = await createTool.handler({ project_slug: slug, args: ["@img-face", "img-body"] }, {});
    expect(createRes2.isError).toBeFalsy();
    const parsed2 = JSON.parse((createRes2.content[0] as { type: "text", text: string }).text);
    expect(parsed2.asset_id).toMatch(/^char-img-face/);
    
    // Test validation for duplicate images
    const createRes3 = await createTool.handler({ project_slug: slug, args: ["img-face", "img-face"] }, {});
    expect(createRes3.isError).toBe(true);

    // Test validation for non-image sources
    await fs.createAsset("vid", "clip", slug);
    const createRes4 = await createTool.handler({ project_slug: slug, args: ["vid-clip"] }, {});
    expect(createRes4.isError).toBe(true);
  });
});
