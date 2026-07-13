import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";
import {
  loadScriptContentsForChat,
  parseChatDecision,
  repairChatRoutingJson,
  sanitizeGenerateImageParams,
  enrichAssetContext,
} from "./chat.js";
import { SCRIPT_FILENAME } from "../jobs/describe-image.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

// Per-test createTestClient + create_project under parallel test load was
// blowing past the 60s hook budget — every per-test call stomps the queue's
// global projectsDir, racing concurrent suites into ENOENT. Tests don't
// share persistent state in conflicting ways; only the KIE_API_KEY env
// mutation needs per-test cleanup.
describe("chat tool", () => {
  let client: Client;
  let tempDir: string;
  const origKey = process.env.KIE_API_KEY;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterAll(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  afterEach(() => {
    if (origKey) process.env.KIE_API_KEY = origKey;
    else delete process.env.KIE_API_KEY;
  });

  it("returns error for unresolved @tag", async () => {
    const result = await client.callTool({
      name: "chat",
      arguments: {
        prompt: "do something with @nonexistent-asset",
        project_slug: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Asset not found");
  });

  it("returns error when KIE_API_KEY is not set", async () => {
    delete process.env.KIE_API_KEY;
    const result = await client.callTool({
      name: "chat",
      arguments: {
        prompt: "generate something cool",
        project_slug: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("not set");
  });

  it("resolves real @tags then returns API key error", async () => {
    // Upload an image to create a real asset
    const data = Buffer.from("fake-png-data").toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "sunset.png", data },
    });

    delete process.env.KIE_API_KEY;
    const result = await client.callTool({
      name: "chat",
      arguments: {
        prompt: "do something with @img-sunset",
        project_slug: "test-proj",
      },
    });

    // Asset resolution succeeds (no "Asset not found" error) but API key check fails
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("KIE_API_KEY");
    expect(content[0].text).not.toContain("Asset not found");
  });

  it("returns error for multiple unresolved @tags", async () => {
    const result = await client.callTool({
      name: "chat",
      arguments: {
        prompt: "combine @img-foo and @vid-bar",
        project_slug: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Asset not found");
    expect(content[0].text).toContain("@img-foo");
    expect(content[0].text).toContain("@vid-bar");
  });

  it("prompt without @tags and no API key returns API key error", async () => {
    delete process.env.KIE_API_KEY;
    const result = await client.callTool({
      name: "chat",
      arguments: {
        prompt: "make me a cool video",
        project_slug: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("KIE_API_KEY");
  });
});

describe("sanitizeGenerateImageParams", () => {
  it("folds @vid-* image_slugs into prompt and keeps only @img-*", () => {
    const out = sanitizeGenerateImageParams({
      prompt: "qr code",
      image_slugs: ["@vid-og", "@img-style"],
    });
    expect(out.image_slugs).toEqual(["@img-style"]);
    expect(out.prompt).toBe("qr code (from source @vid-og)");
  });

  it("builds a prompt when only non-image slugs are present", () => {
    const out = sanitizeGenerateImageParams({
      image_slugs: ["@vid-og"],
    });
    expect(out.image_slugs).toEqual([]);
    expect(out.prompt).toBe("from source @vid-og");
  });

  it("leaves params unchanged when image_slugs is absent", () => {
    const input = { prompt: "qr code image" };
    expect(sanitizeGenerateImageParams(input)).toEqual(input);
  });
});

describe("parseChatDecision / repairChatRoutingJson", () => {
  it("parses clean routing JSON", () => {
    const decision = parseChatDecision(
      '{"tool":"create_watermark","params":{"url":"https://www.youtube.com/watch?v=b-3853ow72Q"},"message":"Creating QR."}',
    );
    expect(decision.tool).toBe("create_watermark");
    expect(decision.params.url).toBe("https://www.youtube.com/watch?v=b-3853ow72Q");
    expect(decision.message).toBe("Creating QR.");
  });

  it("repairs unquoted URLs and trailing commas", () => {
    const raw =
      '{"tool":"create_watermark","params":{"url":https://www.youtube.com/watch?v=b-3853ow72Q,},"message":"Creating QR.",}';
    expect(() => JSON.parse(raw)).toThrow();
    const repaired = repairChatRoutingJson(raw);
    const decision = parseChatDecision(raw);
    expect(repaired).toContain('"https://www.youtube.com/watch?v=b-3853ow72Q"');
    expect(decision.tool).toBe("create_watermark");
    expect(decision.params.url).toBe("https://www.youtube.com/watch?v=b-3853ow72Q");
  });

  it("closes truncated routing JSON missing outer brace and message (live Kie failure)", () => {
    // Exact shape from live multiculty/@vid-og failure (position 106).
    const raw = `{
  "tool": "create_watermark",
  "params": {
    "url": "https://www.youtube.com/watch?v=b-3853ow72Q"
  }`;
    expect(() => JSON.parse(raw)).toThrow();
    const decision = parseChatDecision(raw);
    expect(decision.tool).toBe("create_watermark");
    expect(decision.params.url).toBe("https://www.youtube.com/watch?v=b-3853ow72Q");
    expect(decision.message).toBe("");
  });

  it("closes truncated string values mid-message", () => {
    const raw =
      '{"tool":"create_watermark","params":{"url":"https://x.com/a"},"message":"Creat';
    const decision = parseChatDecision(raw);
    expect(decision.tool).toBe("create_watermark");
    expect(decision.params.url).toBe("https://x.com/a");
    expect(decision.message).toBe("Creat");
  });

  it("includes a raw snippet when JSON is unrecoverable", () => {
    expect(() => parseChatDecision("not json at all")).toThrow(/raw:/);
  });
});

describe("enrichAssetContext", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("attaches source_url from .original.json metadata", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-chat-enrich-"));
    const fs = createFsForTest(tempDir);
    await fs.createProject("enrich-proj");
    const asset = await fs.createAsset("vid", "og", "enrich-proj");
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;

    await fs.writeMetadata(
      asset.value.assetId,
      "original",
      {
        origin: "download",
        source_url: "https://www.youtube.com/watch?v=b-3853ow72Q",
      },
      "enrich-proj",
    );

    const rows = await enrichAssetContext(
      fs,
      [{
        tag: asset.value.assetId,
        asset_type: "video",
        asset_id: asset.value.assetId,
        file_path: join(asset.value.path, "original.mp4"),
      }],
      "enrich-proj",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.source_url).toBe("https://www.youtube.com/watch?v=b-3853ow72Q");
    fs.close();
  });
});

describe("loadScriptContentsForChat", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("reads script body from original.md (not index.md)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-chat-script-"));
    const fs = createFsForTest(tempDir);
    const project = await fs.createProject("chat-script-proj");
    expect(project.ok).toBe(true);

    const script = await fs.createAsset("script", "scene-one", "chat-script-proj");
    expect(script.ok).toBe(true);
    if (!script.ok) return;

    const body = "A pig sits upright on a red stool.";
    const wrote = await fs.writeFile(script.value.assetId, SCRIPT_FILENAME, body, "chat-script-proj");
    expect(wrote.ok).toBe(true);

    const decoy = await fs.writeFile(script.value.assetId, "index.md", "WRONG PLAN FILE", "chat-script-proj");
    expect(decoy.ok).toBe(true);

    const contents = await loadScriptContentsForChat(
      fs,
      [{
        tag: script.value.assetId,
        asset_type: "script",
        asset_id: script.value.assetId,
        file_path: join(script.value.path, SCRIPT_FILENAME),
      }],
      "chat-script-proj",
    );

    expect(contents).toEqual([{ tag: script.value.assetId, content: body }]);
    expect(contents[0]?.content).not.toContain("WRONG PLAN FILE");
    fs.close();
  });

  it("returns empty when only index.md exists (legacy wrong path)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-chat-script-bad-"));
    const fs = createFsForTest(tempDir);
    await fs.createProject("chat-script-proj");
    const script = await fs.createAsset("script", "orphan", "chat-script-proj");
    if (!script.ok) throw new Error(script.error.message);
    await fs.writeFile(script.value.assetId, "index.md", "should not be loaded", "chat-script-proj");

    const contents = await loadScriptContentsForChat(
      fs,
      [{
        tag: script.value.assetId,
        asset_type: "script",
        asset_id: script.value.assetId,
        file_path: join(script.value.path, "index.md"),
      }],
      "chat-script-proj",
    );

    expect(contents).toEqual([]);
    fs.close();
  });
});
