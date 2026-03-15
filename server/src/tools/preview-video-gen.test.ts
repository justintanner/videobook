import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

describe("preview_video_gen tool", () => {
  let client: Client;
  let tempDir: string;
  const origKey = process.env.OPENAI_API_KEY;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterEach(async () => {
    if (origKey) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error when OPENAI_API_KEY is not set", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await client.callTool({
      name: "preview_video_gen",
      arguments: { prompt: "a sunset video", project_slug: "test-proj" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("not set");
  });

  it("resolves @tags before checking API key — prompt with no @tags returns API key error", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await client.callTool({
      name: "preview_video_gen",
      arguments: { prompt: "generate a sunset video", project_slug: "test-proj" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("OPENAI_API_KEY");
  });

  it("returns preview with resolved @tags when dummy API key is set (OpenAI fails, falls through to default)", async () => {
    // Upload an image to create a real asset
    const data = Buffer.from("fake-png-data").toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "sunset.png", data },
    });

    process.env.OPENAI_API_KEY = "sk-test-dummy-key-for-testing";
    const result = await client.callTool({
      name: "preview_video_gen",
      arguments: { prompt: "animate @img-sunset into a video", project_slug: "test-proj" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0].text);

    expect(parsed.category).toBe("video");
    expect(parsed.selected_model).toBe("kling30");
    expect(parsed.model_options).toBeDefined();
    expect(parsed.model_options.length).toBeGreaterThanOrEqual(5);
    expect(parsed.resolved_assets.length).toBeGreaterThanOrEqual(1);
    expect(parsed.resolved_assets[0].tag).toBe("@img-sunset");
    expect(parsed.resolved_assets[0].asset_type).toBe("image");
  });

  it("returns preview with empty resolved_assets when prompt has no @tags and dummy API key", async () => {
    process.env.OPENAI_API_KEY = "sk-test-dummy-key-for-testing";
    const result = await client.callTool({
      name: "preview_video_gen",
      arguments: { prompt: "create an epic sunrise video", project_slug: "test-proj" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0].text);

    expect(parsed.category).toBe("video");
    expect(parsed.resolved_assets).toEqual([]);
    expect(parsed.selected_model).toBe("kling30");
    expect(parsed.model_options.length).toBeGreaterThanOrEqual(5);
  });

  it("includes unresolved @tag warnings in the preview", async () => {
    process.env.OPENAI_API_KEY = "sk-test-dummy-key-for-testing";
    const result = await client.callTool({
      name: "preview_video_gen",
      arguments: { prompt: "animate @img-nonexistent", project_slug: "test-proj" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0].text);

    expect(parsed.validation.warnings.some((w: string) => w.includes("Unresolved @tag"))).toBe(true);
  });
});
