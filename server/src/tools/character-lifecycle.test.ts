import { createEngineForTest } from "../engine.js";
import { describe, it, expect } from "vitest";
import { isUuidV7 } from "videobook-engine";
import { createCharacterDef } from "./create-character.js";
import { setCharacterMetadataDef } from "./set-character-metadata.js";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import * as os from "node:os";

describe("Character lifecycle (create + metadata)", () => {
  it("creates a character and writes free-form metadata", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vc-char-test-"));
    const fs = createEngineForTest(dir);
    const slug = fs.book.get().bookId;
    
    // Create
    const createTool = createCharacterDef(fs);
    const createResult = await createTool.handler({ book_id: slug, args: ["bob"] });
    expect(createResult.isError).toBeFalsy();
    const createdText = (createResult.content[0] as { type: "text", text: string }).text;
    const parsed = JSON.parse(createdText);
    expect(isUuidV7(parsed.asset_id)).toBe(true);
    expect(parsed.display_name).toBe("bob");

    const charId = parsed.asset_id as string;
    const created = fs.artifacts.get(charId);
    expect(created.ok && created.value.kind).toBe("character");
    expect(created.ok && created.value.label).toBe("bob");
    
    // Set metadata
    const setTool = setCharacterMetadataDef(fs);
    const setResult = await setTool.handler({
      book_id: slug,
      char_asset_id: charId,
      metadata: JSON.stringify({ age: 32, traits: ["brave", "tall"] })
    });
    expect(setResult.isError).toBeFalsy();
    
    // Verify metadata
    const read = await fs.metadata.artifacts.read(charId, "character");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toMatchObject({ age: 32, traits: ["brave", "tall"] });
    }
  });

  it("accepts plain-text notes and structured object metadata", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vc-char-meta-"));
    const fs = createEngineForTest(dir);
    const slug = fs.book.get().bookId;

    const createTool = createCharacterDef(fs);
    const createResult = await createTool.handler({ book_id: slug, args: ["ada"] });
    const charId = JSON.parse((createResult.content[0] as { text: string }).text).asset_id as string;
    const setTool = setCharacterMetadataDef(fs);

    // Free-form notes (the previous Invalid JSON path when users typed prose)
    const notesResult = await setTool.handler({
      book_id: slug,
      char_asset_id: charId,
      metadata: "French headshot, friendly tone",
    });
    expect(notesResult.isError).toBeFalsy();
    const notesRead = await fs.metadata.artifacts.read(charId, "character");
    expect(notesRead.ok && notesRead.value).toMatchObject({
      notes: "French headshot, friendly tone",
    });

    // Object passed directly (agents often skip JSON.stringify)
    const objResult = await setTool.handler({
      book_id: slug,
      char_asset_id: charId,
      metadata: { external_character_ref: "character:abc", display_name: "Ada" },
    });
    expect(objResult.isError).toBeFalsy();
    const objRead = await fs.metadata.artifacts.read(charId, "character");
    expect(objRead.ok && objRead.value).toMatchObject({
      external_character_ref: "character:abc",
      display_name: "Ada",
    });

    // Invalid brace-y pseudo-JSON still errors with a helpful message
    const bad = await setTool.handler({
      book_id: slug,
      char_asset_id: charId,
      metadata: "{character_ref: unquoted}",
    });
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toMatch(/Invalid JSON metadata/);
    expect((bad.content[0] as { text: string }).text).toMatch(/double-quoted keys/);
  });

  it("creates a character seeded from one or more existing image assets", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vc-char-test-asset-"));
    const fs = createEngineForTest(dir);
    const slug = fs.book.get().bookId;

    // Create dummy image assets to serve as sources
    const faceAsset = await fs.artifacts.create("img", "face");
    const bodyAsset = await fs.artifacts.create("img", "body");
    if (!faceAsset.ok || !bodyAsset.ok) throw new Error("fixture image creation failed");
    const faceId = faceAsset.value.artifactId;
    const bodyId = bodyAsset.value.artifactId;
    await fs.files.write(faceId, "original.png", "fake data");
    await fs.files.write(bodyId, "original.png", "fake data");

    const createTool = createCharacterDef(fs);

    // Test with one image and explicit name
    const createRes1 = await createTool.handler({ book_id: slug, args: [faceId, "alice"] });
    expect(createRes1.isError).toBeFalsy();
    const parsed1 = JSON.parse((createRes1.content[0] as { type: "text", text: string }).text);
    expect(isUuidV7(parsed1.asset_id)).toBe(true);
    expect(parsed1.display_name).toBe("alice");
    const meta1 = await fs.metadata.artifacts.read(parsed1.asset_id as string, "character");
    expect(meta1.ok && meta1.value).toMatchObject({ display_name: "alice" });

    // Multiple images and no explicit name → the first source's label is the stem
    const createRes2 = await createTool.handler({ book_id: slug, args: [`@${faceId}`, bodyId] });
    expect(createRes2.isError).toBeFalsy();
    const parsed2 = JSON.parse((createRes2.content[0] as { type: "text", text: string }).text);
    expect(isUuidV7(parsed2.asset_id)).toBe(true);
    expect(parsed2.display_name).toBe("face");
    const meta2 = await fs.metadata.artifacts.read(parsed2.asset_id as string, "character");
    expect(meta2.ok && meta2.value).toMatchObject({ display_name: "face" });

    // Test validation for duplicate images
    const createRes3 = await createTool.handler({ book_id: slug, args: [faceId, faceId] });
    expect(createRes3.isError).toBe(true);

    // Test validation for non-image sources
    const clip = await fs.artifacts.create("vid", "clip");
    if (!clip.ok) throw new Error("fixture video creation failed");
    const createRes4 = await createTool.handler({
      book_id: slug,
      args: [clip.value.artifactId],
    });
    expect(createRes4.isError).toBe(true);
  });

  it("seeds display_name when creating a named character with no images", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vc-char-name-only-"));
    const fs = createEngineForTest(dir);
    const slug = fs.book.get().bookId;
    const createTool = createCharacterDef(fs);
    // The typed name becomes the character's display label; the id is a UUID.
    const res = await createTool.handler({ book_id: slug, args: ["the-guy"] });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(isUuidV7(parsed.asset_id)).toBe(true);
    expect(parsed.display_name).toBe("the-guy");
    const meta = await fs.metadata.artifacts.read(parsed.asset_id as string, "character");
    expect(meta.ok && meta.value).toMatchObject({ display_name: "the-guy" });
  });
});
