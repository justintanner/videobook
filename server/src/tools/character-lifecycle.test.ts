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
    const createResult = await createTool.handler({ project_slug: slug, name: "bob" }, {});
    expect(createResult.isError).toBeFalsy();
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
});
