import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  loadGuide,
  buildRewritePromptText,
  buildRewriteMessages,
  buildVisionMessages,
  buildResult,
  extractSceneContext,
  validateSceneRewrite,
  buildSceneRewriteText,
} from "./rewrite-prompt.js";

type TextContent = Array<{ type: string; text: string }>;

// ---------------------------------------------------------------------------
// Pure helper unit tests (no MCP client needed)
// ---------------------------------------------------------------------------

describe("loadGuide", () => {
  it("loads the nano_banana guide successfully", async () => {
    const guide = await loadGuide("nano_banana");
    expect(guide.length).toBeGreaterThan(0);
  });

  it("loads the kling30 guide successfully", async () => {
    const guide = await loadGuide("kling30");
    expect(guide.length).toBeGreaterThan(0);
  });

  it("loads the grok_imagine guide successfully", async () => {
    const guide = await loadGuide("grok_imagine");
    expect(guide.length).toBeGreaterThan(0);
  });

  it("loads the grok_image guide (shares grok_imagine guide)", async () => {
    const guide = await loadGuide("grok_image");
    expect(guide.length).toBeGreaterThan(0);
  });

  it("loads the gpt_image guide successfully", async () => {
    const guide = await loadGuide("gpt_image");
    expect(guide.length).toBeGreaterThan(0);
  });

  it("loads the seedance2 guide successfully", async () => {
    const guide = await loadGuide("seedance2");
    expect(guide.length).toBeGreaterThan(0);
  });

  it("throws for unsupported model", () => {
    expect(() => loadGuide("unknown_model")).toThrow("No prompting guide available");
  });

  it("error message lists supported models", () => {
    expect(() => loadGuide("bogus")).toThrow("nano_banana");
  });
});

describe("buildRewritePromptText", () => {
  it("includes guide and prompt text", () => {
    const text = buildRewritePromptText("guide content here", "user prompt here");
    expect(text).toContain("guide content here");
    expect(text).toContain("user prompt here");
    expect(text).toContain("prompt engineering expert");
  });

  it("includes character limit rule when maxChars is provided", () => {
    const text = buildRewritePromptText("guide", "prompt", { maxChars: 400 });
    expect(text).toContain("HARD LIMIT");
    expect(text).toContain("400");
  });

  it("does not include character limit rule when maxChars is omitted", () => {
    const text = buildRewritePromptText("guide", "prompt");
    expect(text).not.toContain("HARD LIMIT");
  });

  it("injects platform guidance when platform is set", () => {
    const text = buildRewritePromptText("guide", "prompt", { platform: "ig" });
    expect(text).toContain("PLATFORM STYLE");
    expect(text).toContain("Instagram");
  });

  it("injects cleanup directive only when images are also present", () => {
    const withImages = buildRewritePromptText("guide", "prompt", { platform: "tiktok", hasImages: true });
    expect(withImages).toContain("IMAGE CLEANUP");
    const noImages = buildRewritePromptText("guide", "prompt", { platform: "tiktok" });
    expect(noImages).not.toContain("IMAGE CLEANUP");
  });

  it("appends additional instruction when customPrompt is provided", () => {
    const text = buildRewritePromptText("guide", "prompt", { customPrompt: "make it vertical" });
    expect(text).toContain("ADDITIONAL INSTRUCTION: make it vertical");
  });

  it("handles empty prompt (vision-only rewrite)", () => {
    const text = buildRewritePromptText("guide", "", {});
    expect(text).toContain("USER PROMPT TO REWRITE: (none");
  });
});

describe("buildRewriteMessages", () => {
  it("returns a single user message", () => {
    const messages = buildRewriteMessages("guide", "prompt");
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("guide");
    expect(messages[0].content).toContain("prompt");
  });
});

describe("buildVisionMessages", () => {
  it("returns a single user message with image URLs and text", () => {
    const messages = buildVisionMessages("guide", "prompt", ["data:image/png;base64,abc"]);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    const content = messages[0].content;
    expect(content.length).toBe(2); // 1 image + 1 text
    expect(content[0].type).toBe("image_url");
    expect(content[1].type).toBe("text");
  });

  it("includes multiple images when provided", () => {
    const messages = buildVisionMessages("guide", "prompt", [
      "data:image/png;base64,abc",
      "data:image/jpeg;base64,def",
    ]);
    const content = messages[0].content;
    expect(content.length).toBe(3); // 2 images + 1 text
    expect(content[0].type).toBe("image_url");
    expect(content[1].type).toBe("image_url");
    expect(content[2].type).toBe("text");
  });
});

describe("buildResult", () => {
  it("builds a result object with all fields", () => {
    const result = buildResult("kling30", "original", "rewritten", "kling_guide.md");
    expect(result).toEqual({
      model: "kling30",
      original_prompt: "original",
      rewritten_prompt: "rewritten",
      guide_used: "kling_guide.md",
    });
  });
});

describe("extractSceneContext", () => {
  it("uses multi_prompt when provided", () => {
    const params = {
      multi_prompt: [
        { prompt: "scene1", duration: 5 },
        { prompt: "scene2", duration: 3 },
      ],
    };
    const ctx = extractSceneContext(params);
    expect(ctx.scenes).toHaveLength(2);
    expect(ctx.scenes[0].prompt).toBe("scene1");
    expect(ctx.scenes[1].duration).toBe(3);
  });

  it("falls back to single scene from prompt/duration params", () => {
    const params = { prompt: "single scene", duration: 10 };
    const ctx = extractSceneContext(params);
    expect(ctx.scenes).toHaveLength(1);
    expect(ctx.scenes[0].prompt).toBe("single scene");
    expect(ctx.scenes[0].duration).toBe(10);
  });

  it("defaults duration to 8 if not provided", () => {
    const params = { prompt: "a scene" };
    const ctx = extractSceneContext(params);
    expect(ctx.scenes[0].duration).toBe(8);
  });

  it("extracts elements from numbered params", () => {
    const params = {
      prompt: "test",
      input_element1_slugs: ["@img-a"],
      element1_name: "Character",
      element1_desc: "A character",
      input_element2_slugs: ["@img-b"],
      element2_name: "Background",
      element2_desc: "A background",
    };
    const ctx = extractSceneContext(params);
    expect(ctx.elements).toHaveLength(2);
    expect(ctx.elements[0].name).toBe("Character");
    expect(ctx.elements[1].slugs).toEqual(["@img-b"]);
  });

  it("skips elements without slugs", () => {
    const params = {
      prompt: "test",
      element1_name: "Character",
      element1_desc: "A character",
    };
    const ctx = extractSceneContext(params);
    expect(ctx.elements).toHaveLength(0);
  });

  it("extracts refSlugs from input_image_slugs", () => {
    const params = { prompt: "test", input_image_slugs: ["@img-sunset", "@img-dawn"] };
    const ctx = extractSceneContext(params);
    expect(ctx.refSlugs).toEqual(["@img-sunset", "@img-dawn"]);
  });

  it("defaults refSlugs to empty array", () => {
    const params = { prompt: "test" };
    const ctx = extractSceneContext(params);
    expect(ctx.refSlugs).toEqual([]);
  });

  it("extracts aspect_ratio with default 16:9", () => {
    const params = { prompt: "test" };
    const ctx = extractSceneContext(params);
    expect(ctx.aspectRatio).toBe("16:9");
  });

  it("respects custom aspect_ratio", () => {
    const params = { prompt: "test", aspect_ratio: "9:16" };
    const ctx = extractSceneContext(params);
    expect(ctx.aspectRatio).toBe("9:16");
  });
});

describe("validateSceneRewrite", () => {
  it("throws when tool is not kling30", () => {
    expect(() => validateSceneRewrite({ tool: "generate_grok_imagine_video" }, 0)).toThrow(
      "Scene rewrite requires a Kling 3.0 asset",
    );
  });

  it("throws when tool is undefined", () => {
    expect(() => validateSceneRewrite({}, 0)).toThrow("Scene rewrite requires a Kling 3.0 asset");
  });

  it("passes for valid kling30 single-scene at index 0", () => {
    expect(() =>
      validateSceneRewrite({ tool: "generate_kling30_video", prompt: "test" }, 0),
    ).not.toThrow();
  });

  it("throws for scene_index out of range on single scene", () => {
    expect(() =>
      validateSceneRewrite({ tool: "generate_kling30_video", prompt: "test" }, 1),
    ).toThrow("out of range");
  });

  it("passes for valid scene_index in multi_prompt", () => {
    const params = {
      tool: "generate_kling30_video",
      multi_prompt: [
        { prompt: "s0", duration: 5 },
        { prompt: "s1", duration: 3 },
      ],
    };
    expect(() => validateSceneRewrite(params, 1)).not.toThrow();
  });

  it("throws for negative scene_index", () => {
    expect(() =>
      validateSceneRewrite({ tool: "generate_kling30_video", prompt: "test" }, -1),
    ).toThrow("out of range");
  });

  it("throws for scene_index equal to scene count", () => {
    const params = {
      tool: "generate_kling30_video",
      multi_prompt: [{ prompt: "s0", duration: 5 }],
    };
    expect(() => validateSceneRewrite(params, 1)).toThrow("out of range");
  });
});

describe("buildSceneRewriteText", () => {
  it("includes guide, scenes, and target marker", () => {
    const scenes = [
      { prompt: "scene 0", duration: 5 },
      { prompt: "scene 1", duration: 3 },
    ];
    const text = buildSceneRewriteText("the guide", scenes, [], 1);
    expect(text).toContain("the guide");
    expect(text).toContain("scene 0");
    expect(text).toContain("TARGET");
    expect(text).toContain("scene 1");
  });

  it("includes elements when provided", () => {
    const scenes = [{ prompt: "test", duration: 5 }];
    const elements = [{ name: "Hero", desc: "Main character", slugs: ["@img-a"] }];
    const text = buildSceneRewriteText("guide", scenes, elements, 0);
    expect(text).toContain("@Hero");
    expect(text).toContain("Main character");
  });

  it("omits elements section when empty", () => {
    const scenes = [{ prompt: "test", duration: 5 }];
    const text = buildSceneRewriteText("guide", scenes, [], 0);
    expect(text).not.toContain("ELEMENTS");
  });

  it("includes instruction when provided", () => {
    const scenes = [{ prompt: "test", duration: 5 }];
    const text = buildSceneRewriteText("guide", scenes, [], 0, "make it more dramatic");
    expect(text).toContain("ADDITIONAL INSTRUCTION");
    expect(text).toContain("make it more dramatic");
  });

  it("omits instruction when not provided", () => {
    const scenes = [{ prompt: "test", duration: 5 }];
    const text = buildSceneRewriteText("guide", scenes, [], 0);
    expect(text).not.toContain("ADDITIONAL INSTRUCTION");
  });
});

// ---------------------------------------------------------------------------
// MCP tool integration tests
// ---------------------------------------------------------------------------

describe("rewrite_prompt tool", () => {
  let client: Client;
  let tempDir: string;
  const origKey = process.env.OPENAI_API_KEY;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-test-"));
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
      name: "rewrite_prompt",
      arguments: {
        prompt: "a cat running",
        model: "nano_banana",
        project_slug: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("not set");
  });

  it("returns error when prompt is missing in standard mode", async () => {
    process.env.OPENAI_API_KEY = "test-key-for-validation";
    const result = await client.callTool({
      name: "rewrite_prompt",
      arguments: {
        model: "nano_banana",
        project_slug: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Provide a prompt");
  });

  it("returns error for scene rewrite with no .tool.params.json", async () => {
    process.env.OPENAI_API_KEY = "test-key-for-validation";
    // Upload a video to create an asset, but it won't have tool.params metadata
    const data = Buffer.from("fake-data").toString("base64");
    const uploadResult = await client.callTool({
      name: "upload_file",
      arguments: { project_slug: "test-proj", filename: "myvid.mp4", data },
    });
    const uploaded = JSON.parse((uploadResult.content as TextContent)[0].text);

    const result = await client.callTool({
      name: "rewrite_prompt",
      arguments: {
        model: "kling30",
        project_slug: "test-proj",
        asset_slug: uploaded.assetId,
        scene_index: 0,
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("No .tool.params.json");
  });

  it("returns error when image_slugs resolve to no files", async () => {
    process.env.OPENAI_API_KEY = "test-key-for-validation";
    const result = await client.callTool({
      name: "rewrite_prompt",
      arguments: {
        prompt: "a cat",
        model: "nano_banana",
        image_slugs: ["nonexistent-slug"],
        project_slug: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Could not resolve any image files");
  });
});
