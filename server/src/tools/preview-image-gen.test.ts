import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/client";
import { selectPreviewImageModel } from "./preview-image-gen.js";

type TextContent = Array<{ type: string; text: string }>;

/** A well-formed artifact id that is never created in these fixtures. */
const MISSING_ARTIFACT_ID = "01890f1c-0000-7000-8000-0000000000aa";

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
    const upload = await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "sunset.png", data },
    });
    const uploaded = JSON.parse((upload.content as TextContent)[0].text) as {
      artifactId: string;
    };

    const result = await client.callTool({
      name: "prepare_image_generation",
      arguments: {
        prompt: `edit @${uploaded.artifactId} to be colorful`,
        book_id: "test-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0].text);

    expect(parsed.category).toBe("image");
    expect(parsed.selected_model).toBe("nano_banana_2_1");
    expect(parsed.tool_name).toBe("generate_kie_nano_banana_2_1_image");
    expect(parsed.model_options).toBeDefined();
    expect(parsed.model_options.length).toBeGreaterThanOrEqual(3);

    // The resolved asset should appear
    expect(parsed.resolved_assets.length).toBeGreaterThanOrEqual(1);
    expect(parsed.resolved_assets[0].ref).toBe(`@${uploaded.artifactId}`);
    expect(parsed.resolved_assets[0].type).toBe("image");
    expect(parsed.prefilled_values.prompt).toBe("edit to be colorful");
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
    expect(parsed.selected_model).toBe("nano_banana_2_1");
    expect(parsed.tool_name).toBe("generate_kie_nano_banana_2_1_image");
    expect(parsed.model_options.length).toBeGreaterThanOrEqual(3);
  });

  it("includes unresolved @tag warnings in the preview", async () => {
    const result = await client.callTool({
      name: "prepare_image_generation",
      arguments: {
        prompt: `transform @${MISSING_ARTIFACT_ID}`,
        book_id: "test-proj",
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0].text);

    expect(parsed.validation.warnings.some((w: string) => w.includes("Unresolved @tag"))).toBe(true);
  });
});

describe("selectPreviewImageModel", () => {
  const modelOptions = [
    { key: "nano_banana_2_1", image_slots: { min: 0, max: 10 } },
    { key: "nano_banana", image_slots: { min: 0, max: 14 } },
    { key: "gpt_image", image_slots: { min: 0, max: 16 } },
    { key: "gpt_image_sunburst", image_slots: { min: 0, max: 16 } },
    { key: "grok_imagine_image", image_slots: { min: 1, max: 1 } },
    { key: "grok_imagine_text", image_slots: null },
  ];

  it("defaults to Nano Banana 2.1 for fresh text and edits", () => {
    expect(selectPreviewImageModel(undefined, null, 0, modelOptions)).toBe("nano_banana_2_1");
    expect(selectPreviewImageModel(undefined, null, 1, modelOptions)).toBe("nano_banana_2_1");
  });

  it("maps the retired Nano Banana key onto Nano Banana 2.1", () => {
    expect(selectPreviewImageModel(undefined, "nano_banana", 0, modelOptions)).toBe("nano_banana_2_1");
    expect(selectPreviewImageModel(undefined, "nano_banana", 1, modelOptions)).toBe("nano_banana_2_1");
  });

  it("keeps a historical model when it supports the connected media", () => {
    expect(selectPreviewImageModel(undefined, "grok_imagine_text", 0, modelOptions)).toBe("grok_imagine_text");
    expect(selectPreviewImageModel(undefined, "grok_imagine_text", 1, modelOptions)).toBe("nano_banana_2_1");
    expect(selectPreviewImageModel(undefined, "grok_imagine_image", 1, modelOptions)).toBe("grok_imagine_image");
    expect(selectPreviewImageModel(undefined, "grok_imagine_image", 0, modelOptions)).toBe("nano_banana_2_1");
  });

  it("keeps an explicit Nano Banana selection", () => {
    expect(selectPreviewImageModel("nano_banana", null, 0, modelOptions)).toBe("nano_banana");
  });
});
