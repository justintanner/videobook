import { createEngineForTest } from "../fs.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type Engine } from "videobook-engine";
import sharp from "sharp";
import { createGoogleFlow } from "@apicity/googleflow";
import {
  createGoogleFlowCharacterDef,
  listGoogleFlowCharactersDef,
  deleteGoogleFlowCharacterDef,
  getGoogleFlowCharacterDef,
  replaceGoogleFlowCharacterDef,
  createGoogleFlowCharacter,
  listGoogleFlowCharacters,
  deleteGoogleFlowCharacter,
  replaceGoogleFlowCharacter,
  characterImageGenerationIds,
} from "./google-flow-characters.js";

type TextContent = Array<{ type: string; text: string }>;

function makePng(): Promise<Buffer> {
  return sharp({
    create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 128, b: 255, alpha: 1 } },
  }).png().toBuffer();
}

function stubProvider(body: unknown, calls?: Array<{ url: string; method: string }>) {
  const fetchFn: typeof fetch = async (input, init) => {
    if (calls) calls.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return createGoogleFlow({ apiKey: "test-token", fetch: fetchFn });
}

describe("google flow character tools — handler guards", () => {
  let fs: Engine;
  let tempDir: string;
  const originalKey = process.env.GOOGLE_FLOW_API_KEY;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-gf-characters-test-"));
    fs = createEngineForTest(tempDir);
  });

  afterEach(async () => {
    if (originalKey) process.env.GOOGLE_FLOW_API_KEY = originalKey;
    else delete process.env.GOOGLE_FLOW_API_KEY;
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("create errors cleanly when GOOGLE_FLOW_API_KEY is missing", async () => {
    delete process.env.GOOGLE_FLOW_API_KEY;
    const result = await createGoogleFlowCharacterDef(fs).handler({
      book_id: "test-proj",
      display_name: "Hero",
      image_refs: ["@01890f1c-0000-7000-8000-0000000000aa"],
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("GOOGLE_FLOW_API_KEY");
  });

  it("create rejects more than two image refs", async () => {
    process.env.GOOGLE_FLOW_API_KEY = "test-key";
    const result = await createGoogleFlowCharacterDef(fs).handler({
      book_id: "test-proj",
      display_name: "Hero",
      image_refs: [
        "@01890f1c-0000-7000-8000-0000000000aa",
        "@01890f1c-0000-7000-8000-0000000000bb",
        "@01890f1c-0000-7000-8000-0000000000cc",
      ],
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("at most 2 image references");
  });

  it("create resolves real artifact refs then fails closed on a placeholder key", async () => {
    process.env.GOOGLE_FLOW_API_KEY = "test-key";
    const asset = await fs.artifacts.create("img", "hero");
    if (!asset.ok) throw new Error("failed to create image asset");
    await fs.files.write(asset.value.artifactId, "original.png", await makePng());

    const result = await createGoogleFlowCharacterDef(fs).handler({
      book_id: "test-proj",
      display_name: "Hero",
      image_refs: [`@${asset.value.artifactId}`],
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("placeholder");
  });

  it("list fails closed on a placeholder key", async () => {
    process.env.GOOGLE_FLOW_API_KEY = "test-key";
    const result = await listGoogleFlowCharactersDef().handler({});
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("placeholder");
  });

  it("delete fails closed on a placeholder key", async () => {
    process.env.GOOGLE_FLOW_API_KEY = "test-key";
    const result = await deleteGoogleFlowCharacterDef().handler({ ref: "user:1-character:abc" });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("placeholder");
  });

  it("get errors cleanly when GOOGLE_FLOW_API_KEY is missing", async () => {
    delete process.env.GOOGLE_FLOW_API_KEY;
    const result = await getGoogleFlowCharacterDef().handler({
      ref: "user:1-character:abc",
    });
    expect(result.isError).toBe(true);
  });

  it("replace errors cleanly when GOOGLE_FLOW_API_KEY is missing", async () => {
    delete process.env.GOOGLE_FLOW_API_KEY;
    const result = await replaceGoogleFlowCharacterDef(fs).handler({
      ref: "user:1-character:abc",
    });
    expect(result.isError).toBe(true);
  });
});

describe("google flow character cores — stubbed provider", () => {
  it("creates a character and returns its ref", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const provider = stubProvider({ character: "user:1-character:abc", displayName: "Hero" }, calls);
    const result = await createGoogleFlowCharacter(provider, {
      displayName: "Hero",
      imageReferences: ["media:1", "media:2"],
      personalityNotes: "brave",
    });
    expect(result).toMatchObject({ character_ref: "user:1-character:abc", display_name: "Hero", status: "created" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/characters");
  });

  it("throws when at least one image reference is missing", async () => {
    const provider = stubProvider({ character: "x" });
    await expect(
      createGoogleFlowCharacter(provider, { displayName: "Hero", imageReferences: [] }),
    ).rejects.toThrow(/at least one image reference/);
  });

  it("throws with the raw body when create returns no ref", async () => {
    const provider = stubProvider({ status: "queued" });
    await expect(
      createGoogleFlowCharacter(provider, { displayName: "Hero", imageReferences: ["media:1"] }),
    ).rejects.toThrow(/no character ref/);
  });

  it("lists characters into normalized entities", async () => {
    const provider = stubProvider({ characters: [{ character: "c1", displayName: "Hero" }] });
    const result = await listGoogleFlowCharacters(provider, {
      email: "acct@x.com",
      includePreviews: false,
    });
    expect(result).toMatchObject({ email: "acct@x.com", count: 1 });
    expect(result.characters[0]).toMatchObject({
      ref: "c1",
      display_name: "Hero",
      thumbnail_url: null,
    });
  });

  it("enriches list items with retrieve thumbnails while preserving list names", async () => {
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/characters/") && !url.endsWith("/characters") && !url.includes("?")) {
        return new Response(JSON.stringify({
          character: "c1",
          displayName: "Carol",
          thumbnailUrl: "https://example.com/thumb.jpg",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        characters: [{ character: "c1", displayName: "Hero" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const provider = createGoogleFlow({ apiKey: "test-token", fetch: fetchFn });
    const result = await listGoogleFlowCharacters(provider, {
      email: "acct@x.com",
      includePreviews: true,
    });
    expect(result.characters[0]).toMatchObject({
      ref: "c1",
      display_name: "Hero",
      thumbnail_url: "https://example.com/thumb.jpg",
    });
    expect(result.characters[0].raw).toHaveProperty("_conflict", "singleton-read-disagrees");
  });

  it("deletes a character by ref", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const provider = stubProvider({ deleted: true }, calls);
    const result = await deleteGoogleFlowCharacter(provider, "user:1-character:abc");
    expect(result).toEqual({ ref: "user:1-character:abc", status: "deleted" });
    expect(calls[0].method).toBe("DELETE");
  });
});

describe("characterImageGenerationIds", () => {
  const REF = "user:2935-email:6a75-character:2ad2bdbd-imgs:2";

  it("rebuilds create-time ids from the ref prefix and retrieve mediaIds", () => {
    const ids = characterImageGenerationIds(REF, {
      imageReferences: [
        { workflowId: "w1", mediaId: "aaa-111" },
        { workflowId: "w2", mediaId: "bbb-222" },
      ],
    });
    expect(ids).toEqual([
      "user:2935-email:6a75-image:aaa-111",
      "user:2935-email:6a75-image:bbb-222",
    ]);
  });

  it("caps at two ids and skips entries without a mediaId", () => {
    const ids = characterImageGenerationIds(REF, {
      imageReferences: [
        { workflowId: "w0" },
        { mediaId: "a" },
        { mediaId: "b" },
        { mediaId: "c" },
      ],
    });
    expect(ids).toEqual([
      "user:2935-email:6a75-image:a",
      "user:2935-email:6a75-image:b",
    ]);
  });

  it("throws when the ref carries no -character: segment", () => {
    expect(() => characterImageGenerationIds("user:1-imgs:1", { imageReferences: [{ mediaId: "a" }] }))
      .toThrow(/-character:/);
  });

  it("throws when the retrieve body has no usable mediaIds", () => {
    expect(() => characterImageGenerationIds(REF, { imageReferences: [{ workflowId: "w1" }] }))
      .toThrow(/no imageReferences/);
  });
});

describe("replaceGoogleFlowCharacter — stubbed provider", () => {
  const OLD_REF = "user:2935-email:6a75-character:old111-imgs:2";
  const NEW_REF = "user:2935-email:6a75-character:new222-imgs:2";

  function routingProvider(opts: {
    calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }>;
  }) {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      opts.calls.push({ url, method, body });
      if (method === "GET") {
        return new Response(JSON.stringify({
          character: OLD_REF,
          displayName: "n",
          personalityNotes: "grumpy but loyal",
          voice: { voice: "Kore" },
          imageReferences: [
            { workflowId: "w1", mediaId: "media-a" },
            { workflowId: "w2", mediaId: "media-b" },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "POST") {
        if (url.includes("/assets")) {
          return new Response(JSON.stringify({ mediaGenerationId: "user:1-image:media-new" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        const name = body?.displayName ?? "n";
        return new Response(JSON.stringify({ character: NEW_REF, displayName: name }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    return createGoogleFlow({ apiKey: "test-token", fetch: fetchFn });
  }

  it("replaces display name and clears voice", async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const provider = routingProvider({ calls });

    const result = await replaceGoogleFlowCharacter(provider, undefined, undefined, OLD_REF, {
      displayName: "Nigel",
      clearVoice: true,
    });
    expect(result.character_ref).toBe(NEW_REF);
    expect(result.status).toBe("replaced");

    const create = calls[2];
    expect(create.body).toMatchObject({
      displayName: "Nigel",
      personalityNotes: "grumpy but loyal",
      imageReference_1: "user:2935-email:6a75-image:media-a",
      imageReference_2: "user:2935-email:6a75-image:media-b",
    });
    expect(create.body).not.toHaveProperty("voice");
  });

  it("replaces images and notes with new values", async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
    const provider = routingProvider({ calls });

    const tempDir = await mkdtemp(join(tmpdir(), "videocity-replace-test-"));
    const fs = createEngineForTest(tempDir);
    const asset = await fs.artifacts.create("img", "newimg");
    if (!asset.ok) throw new Error("failed to create asset");
    await fs.files.write(asset.value.artifactId, "original.png", await makePng());

    const result = await replaceGoogleFlowCharacter(provider, fs, "test-proj", OLD_REF, {
      imageRefs: [`@${asset.value.artifactId}`],
      personalityNotes: "new notes",
    });
    expect(result.character_ref).toBe(NEW_REF);
    expect(result.status).toBe("replaced");

    const create = calls[calls.length - 2]; // before delete
    expect(create.body).toMatchObject({
      displayName: "n",
      personalityNotes: "new notes",
      voice: "Kore",
    });
    expect(create.body).toHaveProperty("imageReference_1");
    // Should have only 1 imageReference because we only gave 1 image ref
    expect(create.body).not.toHaveProperty("imageReference_2");
    
    await rm(tempDir, { recursive: true, force: true });
  });
});
