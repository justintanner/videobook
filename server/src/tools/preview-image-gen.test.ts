import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { selectPreviewImageModel } from "./preview-image-gen.js";

type TextContent = Array<{ type: string; text: string }>;

describe("preview_image tool", () => {
  let client: Client;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
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
      arguments: { book_id: "test-proj", filename: "sunset.png", data },
    });

    const result = await client.callTool({
      name: "prepare_image_generation",
      arguments: { prompt: "edit @img-sunset to be colorful", book_id: "test-proj" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0].text);

    expect(parsed.category).toBe("image");
    expect(parsed.selected_model).toBe("gpt_image");
    expect(parsed.tool_name).toBe("generate_kie_gpt_image_2_image_to_image");
    expect(parsed.model_options).toBeDefined();
    expect(parsed.model_options.length).toBeGreaterThanOrEqual(3);

    // The resolved asset should appear
    expect(parsed.resolved_assets.length).toBeGreaterThanOrEqual(1);
    expect(parsed.resolved_assets[0].slug).toBe("@img-sunset");
    expect(parsed.resolved_assets[0].type).toBe("image");
  });

  it("returns preview with empty resolved_assets when prompt has no @tags", async () => {
    const result = await client.callTool({
      name: "prepare_image_generation",
      arguments: { prompt: "a sunset landscape", book_id: "test-proj" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0].text);

    expect(parsed.category).toBe("image");
    expect(parsed.resolved_assets).toEqual([]);
    expect(parsed.selected_model).toBe("gpt_image_text");
    expect(parsed.tool_name).toBe("generate_kie_gpt_image_2_text_to_image");
    expect(parsed.model_options.length).toBeGreaterThanOrEqual(3);
  });

  it("includes unresolved @tag warnings in the preview", async () => {
    const result = await client.callTool({
      name: "prepare_image_generation",
      arguments: { prompt: "transform @img-nonexistent", book_id: "test-proj" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0].text);

    expect(parsed.validation.warnings.some((w: string) => w.includes("Unresolved @tag"))).toBe(true);
  });
});

describe("selectPreviewImageModel", () => {
  const modelOptions = [
    { key: "nano_banana", image_slots: { min: 0, max: 14 } },
    { key: "gpt_image", image_slots: { min: 1, max: 16 } },
    { key: "gpt_image_text", image_slots: null },
    { key: "grok_imagine_image", image_slots: { min: 1, max: 1 } },
    { key: "grok_imagine_text", image_slots: null },
  ];

  it("uses the matching GPT Image 2 variant for the reference mode", () => {
    expect(selectPreviewImageModel(undefined, null, 0, modelOptions)).toBe("gpt_image_text");
    expect(selectPreviewImageModel(undefined, null, 1, modelOptions)).toBe("gpt_image");
  });

  it("does not silently restore Nano Banana from history", () => {
    expect(selectPreviewImageModel(undefined, "nano_banana", 0, modelOptions)).toBe("gpt_image_text");
    expect(selectPreviewImageModel(undefined, "nano_banana", 1, modelOptions)).toBe("gpt_image");
  });

  it("keeps compatible non-Gemini history and rejects incompatible modes", () => {
    expect(selectPreviewImageModel(undefined, "grok_imagine_text", 0, modelOptions)).toBe("grok_imagine_text");
    expect(selectPreviewImageModel(undefined, "grok_imagine_text", 1, modelOptions)).toBe("gpt_image");
    expect(selectPreviewImageModel(undefined, "grok_imagine_image", 1, modelOptions)).toBe("grok_imagine_image");
    expect(selectPreviewImageModel(undefined, "grok_imagine_image", 0, modelOptions)).toBe("gpt_image_text");
  });

  it("keeps an explicit Nano Banana selection", () => {
    expect(selectPreviewImageModel("nano_banana", null, 0, modelOptions)).toBe("nano_banana");
  });
});
