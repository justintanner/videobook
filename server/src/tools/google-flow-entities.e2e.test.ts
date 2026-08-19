import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { isPlaceholderApiKey } from "../api-key.js";
import { createGoogleFlowProvider } from "../jobs/_google-flow.js";
import {
  createGoogleFlowVoice,
  listGoogleFlowVoices,
  deleteGoogleFlowVoice,
} from "./google-flow-voices.js";
import {
  createGoogleFlowCharacter,
  listGoogleFlowCharacters,
  deleteGoogleFlowCharacter,
  replaceGoogleFlowCharacter,
} from "./google-flow-characters.js";

/**
 * Live Google Flow voice/character lifecycle against useapi.net. Consumes plan
 * credits, so it is a manual run only: it SKIPS unless a real GOOGLE_FLOW_API_KEY
 * is present (the shared test guard in vitest.setup.ts also blocks outbound
 * fetch, so this executes only when that guard is deliberately relaxed). Each
 * entity is cleaned up in a finally block so a failed assertion never leaks a
 * created voice/character.
 */
const KEY = process.env.GOOGLE_FLOW_API_KEY;
const LIVE = !!KEY && !isPlaceholderApiKey(KEY);

// Extract the id useapi returns from POST /assets (nested one level).
function readMediaGenerationId(res: Record<string, unknown>): string {
  const outer = res.mediaGenerationId;
  if (typeof outer === "string") return outer;
  if (outer && typeof outer === "object") {
    const inner = (outer as Record<string, unknown>).mediaGenerationId;
    if (typeof inner === "string") return inner;
  }
  throw new Error(`no mediaGenerationId in asset upload response: ${JSON.stringify(res)}`);
}

describe.skipIf(!LIVE)("google flow entities — live lifecycle", () => {
  it("creates, lists, retrieves, and deletes a custom voice", async () => {
    const provider = createGoogleFlowProvider();
    const created = await createGoogleFlowVoice(provider, {
      voice: "Kore",
      displayName: `videocity-test-${Date.now()}`,
      dialog: "This is a videocity integration test voice.",
      voicePerformance: "calm and clear",
    });
    expect(created.voice_ref).toBeTruthy();

    try {
      const listed = await listGoogleFlowVoices(provider, { source: "user" });
      expect(listed.voices.some((v) => v.ref === created.voice_ref)).toBe(true);

      // Retrieve-by-ref proves the §16 raw-path decode on a ':'-bearing ref.
      const retrieved = await provider.get.v1.voices.retrieve({ ref: created.voice_ref });
      expect(retrieved).toBeTruthy();
    } finally {
      await deleteGoogleFlowVoice(provider, created.voice_ref);
    }

    const after = await listGoogleFlowVoices(provider, { source: "user" });
    expect(after.voices.some((v) => v.ref === created.voice_ref)).toBe(false);
  });

  it("creates, retrieves, and deletes a character from an uploaded image", async () => {
    const provider = createGoogleFlowProvider();
    const png = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 1 } },
    }).png().toBuffer();

    const uploaded = await provider.v1.assets({
      body: new Blob([new Uint8Array(png)], { type: "image/png" }),
      contentType: "image/png",
    });
    const mediaGenerationId = readMediaGenerationId(uploaded as Record<string, unknown>);

    const created = await createGoogleFlowCharacter(provider, {
      displayName: `videocity-test-${Date.now()}`,
      imageReferences: [mediaGenerationId],
      personalityNotes: "integration test character",
    });
    expect(created.character_ref).toBeTruthy();

    try {
      const retrieved = await provider.get.v1.characters.retrieve({ ref: created.character_ref });
      expect(retrieved).toBeTruthy();
      const listed = await listGoogleFlowCharacters(provider, {});
      expect(listed.characters.some((c) => c.ref === created.character_ref)).toBe(true);
    } finally {
      await deleteGoogleFlowCharacter(provider, created.character_ref);
    }
  });

  it("renames a character via recreate+delete, preserving its images", async () => {
    const provider = createGoogleFlowProvider();
    const png = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 50, g: 50, b: 200, alpha: 1 } },
    }).png().toBuffer();

    const uploaded = await provider.v1.assets({
      body: new Blob([new Uint8Array(png)], { type: "image/png" }),
      contentType: "image/png",
    });
    const mediaGenerationId = readMediaGenerationId(uploaded as Record<string, unknown>);

    const created = await createGoogleFlowCharacter(provider, {
      displayName: `videocity-rename-src-${Date.now()}`,
      imageReferences: [mediaGenerationId],
    });

    let surviving = created.character_ref;
    try {
      const newName = `videocity-renamed-${Date.now()}`;
      const renamed = await replaceGoogleFlowCharacter(
        provider,
        undefined,
        undefined,
        created.character_ref,
        { displayName: newName },
      );
      surviving = renamed.character_ref;
      expect(renamed.old_ref).toBe(created.character_ref);
      expect(renamed.character_ref).not.toBe(created.character_ref);
      expect(renamed.warning).toBeUndefined();

      const listed = await listGoogleFlowCharacters(provider, {});
      const entry = listed.characters.find((c) => c.ref === renamed.character_ref);
      expect(entry?.display_name).toBe(newName);
      expect(entry?.image_count).toBe(1);
      expect(listed.characters.some((c) => c.ref === created.character_ref)).toBe(false);
    } finally {
      await deleteGoogleFlowCharacter(provider, surviving);
    }
  });
});
