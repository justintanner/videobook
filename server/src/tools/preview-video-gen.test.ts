import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { selectPreviewVideoModel } from "./preview-video-gen.js";

type TextContent = Array<{ type: string; text: string }>;

describe("preview_video tool", () => {
  let client: Client;
  let tempDir: string;
  const origKey = process.env.OPENAI_API_KEY;
  const origGoogleKey = process.env.GOOGLE_FLOW_API_KEY;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
    client = await createTestClient(tempDir);
    await client.callTool({
      name: "create_project",
      arguments: { book_id: "test-proj" },
    });
  });

  afterEach(async () => {
    if (origKey) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
    if (origGoogleKey) process.env.GOOGLE_FLOW_API_KEY = origGoogleKey;
    else delete process.env.GOOGLE_FLOW_API_KEY;
    await client?.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns error when OPENAI_API_KEY is not set", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await client.callTool({
      name: "prepare_video_generation",
      arguments: { prompt: "a sunset video", book_id: "test-proj" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("not set");
  });

  it("resolves @tags before checking API key — prompt with no @tags returns API key error", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await client.callTool({
      name: "prepare_video_generation",
      arguments: { prompt: "generate a sunset video", book_id: "test-proj" },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("OPENAI_API_KEY");
  });

  it("returns preview with resolved @tags when model selection skips routing", async () => {
    const data = Buffer.from("fake-png-data").toString("base64");
    await client.callTool({
      name: "upload_file",
      arguments: { book_id: "test-proj", filename: "sunset.png", data },
    });

    const result = await client.callTool({
      name: "prepare_video_generation",
      arguments: { prompt: "animate @img-sunset into a video", book_id: "test-proj", selected_model: "kling30" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0].text);

    expect(parsed.category).toBe("video");
    expect(parsed.selected_model).toBe("kling30");
    expect(parsed.model_options).toBeDefined();
    expect(parsed.model_options.length).toBeGreaterThanOrEqual(5);
    expect(parsed.resolved_assets.length).toBeGreaterThanOrEqual(1);
    expect(parsed.resolved_assets[0].slug).toBe("@img-sunset");
    expect(parsed.resolved_assets[0].type).toBe("image");
  });

  it("returns preview with empty resolved_assets when prompt has no @tags and model selection skips routing", async () => {
    const result = await client.callTool({
      name: "prepare_video_generation",
      arguments: { prompt: "create an epic sunrise video", book_id: "test-proj", selected_model: "kling30" },
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
    const result = await client.callTool({
      name: "prepare_video_generation",
      arguments: { prompt: "animate @img-nonexistent", book_id: "test-proj", selected_model: "kling30" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0].text);

    expect(parsed.validation.warnings.some((w: string) => w.includes("Unresolved @tag"))).toBe(true);
  });

  it("returns the Google Omni provider-specific schema when google is selected", async () => {
    process.env.GOOGLE_FLOW_API_KEY = "test-google-key";

    const result = await client.callTool({
      name: "prepare_video_generation",
      arguments: {
        prompt: "generate with omni",
        book_id: "test-proj",
        selected_model: "gemini_omni",
        selected_provider: "google",
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as TextContent;
    const parsed = JSON.parse(content[0].text);

    expect(parsed.selected_model).toBe("gemini_omni");
    expect(parsed.selected_provider).toBe("google");
    expect(parsed.tool_name).toBe("generate_google_flow_omni_flash_video");
    expect(parsed.schema.properties.first_frame_slug).toBeDefined();
    expect(parsed.schema.properties.resolution).toBeUndefined();
    expect(parsed.schema.required).not.toContain("duration");
    expect(parsed.schema.defaults.duration).toBe("8");
    expect(parsed.schema.properties.voice_refs).toBeDefined();
    expect(parsed.schema.properties.character_refs).toBeDefined();
    expect(parsed.schema.required).not.toContain("voice_refs");
    expect(parsed.schema.required).not.toContain("character_refs");

    // The omni option ships a modes contract; the kie option does not.
    const omniOption = parsed.model_options.find((o: { key: string }) => o.key === "gemini_omni");
    expect(omniOption.modes).not.toBeNull();
    expect(omniOption.modes.modes.map((m: { key: string }) => m.key)).toEqual(["t2v", "i2v", "r2v", "edit"]);
    const nonModed = parsed.model_options.find((o: { key: string }) => o.key === "kling30");
    expect(nonModed.modes).toBeNull();
  });
});

describe("selectPreviewVideoModel", () => {
  it("uses Seedance 2 when no explicit, historical, or routed model applies", () => {
    expect(selectPreviewVideoModel(undefined, null, "unknown_tool")).toBe("seedance2");
  });

  it("does not silently restore Gemini Omni from history", () => {
    expect(selectPreviewVideoModel(
      undefined,
      "gemini_omni",
      "generate_kie_seedance_2_0_video",
    )).toBe("seedance2");
  });

  it("keeps an explicit Gemini Omni selection", () => {
    expect(selectPreviewVideoModel(
      "gemini_omni",
      "seedance2",
      "generate_kie_seedance_2_0_video",
    )).toBe("gemini_omni");
  });
});
