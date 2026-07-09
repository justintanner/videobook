import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";
import { loadScriptContentsForChat } from "./chat.js";
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
