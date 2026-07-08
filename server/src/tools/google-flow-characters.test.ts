import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFs, type VideocityFs } from "videocity-engine";
import sharp from "sharp";
import { createGoogleFlow } from "@apicity/googleflow";
import {
  createGoogleFlowCharacterDef,
  listGoogleFlowCharactersDef,
  deleteGoogleFlowCharacterDef,
  createGoogleFlowCharacter,
  listGoogleFlowCharacters,
  deleteGoogleFlowCharacter,
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
  let fs: VideocityFs;
  let tempDir: string;
  const originalKey = process.env.GOOGLE_FLOW_API_KEY;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-gf-characters-test-"));
    fs = createFs({ projectsDir: tempDir });
    await fs.createProject("test-proj");
  });

  afterEach(async () => {
    if (originalKey) process.env.GOOGLE_FLOW_API_KEY = originalKey;
    else delete process.env.GOOGLE_FLOW_API_KEY;
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("create errors cleanly when GOOGLE_FLOW_API_KEY is missing", async () => {
    delete process.env.GOOGLE_FLOW_API_KEY;
    const result = await createGoogleFlowCharacterDef(fs).handler({
      project_slug: "test-proj",
      display_name: "Hero",
      image_slugs: ["@img-hero"],
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("GOOGLE_FLOW_API_KEY");
  });

  it("create rejects more than two image slugs", async () => {
    process.env.GOOGLE_FLOW_API_KEY = "test-key";
    const result = await createGoogleFlowCharacterDef(fs).handler({
      project_slug: "test-proj",
      display_name: "Hero",
      image_slugs: ["@img-a", "@img-b", "@img-c"],
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("at most 2 image references");
  });

  it("create resolves real slugs then fails closed on a placeholder key", async () => {
    process.env.GOOGLE_FLOW_API_KEY = "test-key";
    const asset = await fs.createAsset("img", "hero", "test-proj");
    if (!asset.ok) throw new Error("failed to create image asset");
    await fs.writeFile(asset.value.assetId, "original.png", await makePng(), "test-proj");

    const result = await createGoogleFlowCharacterDef(fs).handler({
      project_slug: "test-proj",
      display_name: "Hero",
      image_slugs: [`@${asset.value.assetId}`],
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
});

describe("google flow character cores — stubbed provider", () => {
  it("creates a character and returns its ref", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const provider = stubProvider({ character: "user:1-character:abc" }, calls);
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
    const result = await listGoogleFlowCharacters(provider, { email: "acct@x.com" });
    expect(result).toMatchObject({ email: "acct@x.com", count: 1 });
    expect(result.characters[0]).toMatchObject({ ref: "c1", display_name: "Hero" });
  });

  it("deletes a character by ref", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const provider = stubProvider({ deleted: true }, calls);
    const result = await deleteGoogleFlowCharacter(provider, "user:1-character:abc");
    expect(result).toEqual({ ref: "user:1-character:abc", status: "deleted" });
    expect(calls[0].method).toBe("DELETE");
  });
});
