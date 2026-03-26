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

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { project_slug: "test-proj" },
    });
  });

  afterEach(async () => {
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("resolves real @tags and returns preview with resolved assets", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "sunset.png", data },
    });

    const result = await client.callTool({
      name: "preview_image",
      arguments: { prompt: "edit @img-sunset to be colorful", project_slug: "test-proj" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0].text);

    expect(parsed.category).toBe("image");
    expect(parsed.selected_model).toBe("nano_banana");
    expect(parsed.model_options).toBeDefined();
    expect(parsed.model_options.length).toBeGreaterThanOrEqual(3);

    // The resolved asset should appear
    expect(parsed.resolved_assets.length).toBeGreaterThanOrEqual(1);
    expect(parsed.resolved_assets[0].slug).toBe("@img-sunset");
    expect(parsed.resolved_assets[0].type).toBe("image");
  });

  it("returns preview with empty resolved_assets when prompt has no @tags", async () => {
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
