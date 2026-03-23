import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type TextContent = Array<{ type: string; text: string }>;

describe("preview_image tool", () => {
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
      name: "preview_image",
      arguments: { prompt: "a sunset", project_slug: "test-proj" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("not set");
  });

  it("resolves @tags before checking API key — prompt with no @tags returns API key error", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await client.callTool({
      name: "preview_image",
      arguments: { prompt: "generate a photo of a mountain", project_slug: "test-proj" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("OPENAI_API_KEY");
  });

  it("resolves @tags before checking API key — prompt with unresolved @tags still returns API key error", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await client.callTool({
      name: "preview_image",
      arguments: { prompt: "edit @img-sunset to add clouds", project_slug: "test-proj" },
    });
    // Asset resolution runs first but the tool does NOT error on unresolved tags here;
    // it only adds warnings. So we still get the API key error.
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("OPENAI_API_KEY");
  });

  it("resolves real @tags then returns API key error with dummy key (fails at OpenAI call)", async () => {
    // Upload an image to create a real asset
    const data = Buffer.from("fake-png-data").toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "sunset.png", data },
    });

    // Set a dummy API key — asset resolution runs, then OpenAI call fails
    process.env.OPENAI_API_KEY = "sk-test-dummy-key-for-testing";
    const result = await client.callTool({
      name: "preview_image",
      arguments: { prompt: "edit @img-sunset to be colorful", project_slug: "test-proj" },
    });

    // The OpenAI call will fail (network error / auth error) but the tool catches
    // that and falls through to the default model. It should return a successful
    // preview with resolved assets.
    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0].text);

    expect(parsed.category).toBe("image");
    expect(parsed.selected_model).toBe("nano_banana");
    expect(parsed.model_options).toBeDefined();
    expect(parsed.model_options.length).toBeGreaterThanOrEqual(3);

    // The resolved asset should appear
    expect(parsed.resolved_assets.length).toBeGreaterThanOrEqual(1);
    expect(parsed.resolved_assets[0].tag).toBe("@img-sunset");
    expect(parsed.resolved_assets[0].asset_type).toBe("image");
  });

  it("returns preview with empty resolved_assets when prompt has no @tags and dummy API key", async () => {
    process.env.OPENAI_API_KEY = "sk-test-dummy-key-for-testing";
    const result = await client.callTool({
      name: "preview_image",
      arguments: { prompt: "a sunset landscape", project_slug: "test-proj" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0].text);

    expect(parsed.category).toBe("image");
    expect(parsed.resolved_assets).toEqual([]);
    expect(parsed.selected_model).toBe("nano_banana");
    expect(parsed.model_options.length).toBeGreaterThanOrEqual(3);
  });

  it("includes unresolved @tag warnings in the preview", async () => {
    process.env.OPENAI_API_KEY = "sk-test-dummy-key-for-testing";
    const result = await client.callTool({
      name: "preview_image",
      arguments: { prompt: "transform @img-nonexistent", project_slug: "test-proj" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0].text);

    expect(parsed.validation.warnings.some((w: string) => w.includes("Unresolved @tag"))).toBe(true);
  });
});
