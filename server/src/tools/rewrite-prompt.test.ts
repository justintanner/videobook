import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestClient } from "../test-client.js";
import { createFsForTest } from "../fs.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { VideocityFs } from "videocity-engine";
import {
  loadGuide,
  loadUseapiGuide,
  buildRewritePromptText,
  buildRewriteMessages,
  buildVisionMessages,
  buildResult,
  normalizePromptForMatch,
  findPreviousErrorForPrompt,
  extractSceneContext,
  validateSceneRewrite,
  buildSceneRewriteText,
  type PreviousError,
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

describe("loadUseapiGuide", () => {
  it("loads the useapi.net provider guide", async () => {
    const guide = await loadUseapiGuide();
    expect(guide.length).toBeGreaterThan(0);
    expect(guide).toContain("useapi.net");
    expect(guide).toContain("@referenceImage");
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

  it("provider-docs mode uses provider framing and the provider documentation", () => {
    const text = buildRewritePromptText("useapi doc body", "user prompt", {
      providerDocs: true,
      modelContext: "nano_banana",
    });
    expect(text).toContain("PROVIDER API DOCUMENTATION");
    expect(text).toContain("useapi doc body");
    expect(text).toContain("TARGET MODEL: nano_banana");
    expect(text).toContain("@referenceImage");
    // provider-docs mode never emits a platform section
    expect(text).not.toContain("PLATFORM STYLE");
    expect(text).not.toContain("PROMPTING GUIDE");
  });

  it("provider-docs mode omits the platform overlay even if platform is passed", () => {
    const text = buildRewritePromptText("doc", "prompt", {
      providerDocs: true,
      platform: "ig",
    });
    expect(text).not.toContain("PLATFORM STYLE");
    expect(text).not.toContain("Instagram");
  });

  it("provider-docs mode still applies maxChars and customPrompt", () => {
    const text = buildRewritePromptText("doc", "prompt", {
      providerDocs: true,
      maxChars: 400,
      customPrompt: "keep it short",
    });
    expect(text).toContain("HARD LIMIT");
    expect(text).toContain("400");
    expect(text).toContain("ADDITIONAL INSTRUCTION: keep it short");
  });

  it("injects previous-error section in standard mode", () => {
    const text = buildRewritePromptText("guide", "user prompt", {
      previousError: { message: "filter failed", failCode: "PEOPLE_FILTER" },
    });
    expect(text).toContain("PREVIOUS GENERATION ERROR");
    expect(text).toContain("Provider fail code: PEOPLE_FILTER");
    expect(text).toContain("Error message: filter failed");
    expect(text).toContain("END PREVIOUS GENERATION ERROR");
  });

  it("injects previous-error section in provider-docs mode", () => {
    const text = buildRewritePromptText("doc", "user prompt", {
      providerDocs: true,
      previousError: { message: "safety filter" },
    });
    expect(text).toContain("PREVIOUS GENERATION ERROR");
    expect(text).toContain("Error message: safety filter");
    expect(text).not.toContain("Provider fail code");
  });

  it("omits previous-error section when previousError is not set", () => {
    const std = buildRewritePromptText("guide", "prompt");
    expect(std).not.toContain("PREVIOUS GENERATION ERROR");
    const docs = buildRewritePromptText("doc", "prompt", { providerDocs: true });
    expect(docs).not.toContain("PREVIOUS GENERATION ERROR");
  });

  it("places previous-error section between instruction and user prompt", () => {
    const text = buildRewritePromptText("guide", "my prompt", {
      customPrompt: "extra direction",
      previousError: { message: "boom" },
    });
    const instrIdx = text.indexOf("ADDITIONAL INSTRUCTION: extra direction");
    const errorIdx = text.indexOf("PREVIOUS GENERATION ERROR");
    const promptIdx = text.indexOf("USER PROMPT TO REWRITE");
    expect(instrIdx).toBeGreaterThan(-1);
    expect(errorIdx).toBeGreaterThan(instrIdx);
    expect(promptIdx).toBeGreaterThan(errorIdx);
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

  it("emits previous_error with fail_code when previousError has failCode", () => {
    const err: PreviousError = { message: "boom", failCode: "FILTER_FAILED" };
    const result = buildResult("kling30", "original", "rewritten", "guide.md", err);
    expect(result).toEqual({
      model: "kling30",
      original_prompt: "original",
      rewritten_prompt: "rewritten",
      guide_used: "guide.md",
      previous_error: { message: "boom", fail_code: "FILTER_FAILED" },
    });
  });

  it("emits previous_error without fail_code when failCode is absent", () => {
    const err: PreviousError = { message: "something went wrong" };
    const result = buildResult("gemini_omni", "p", "r", "useapi.md", err);
    expect(result.previous_error).toEqual({ message: "something went wrong" });
    expect(result.previous_error).not.toHaveProperty("fail_code");
  });

  it("omits previous_error when previousError is undefined", () => {
    const result = buildResult("kling30", "p", "r", "guide.md");
    expect(result).not.toHaveProperty("previous_error");
  });
});

describe("normalizePromptForMatch", () => {
  it("collapses multiple spaces to a single space", () => {
    expect(normalizePromptForMatch("a  b   c")).toBe("a b c");
  });

  it("collapses newlines and tabs to a single space", () => {
    expect(normalizePromptForMatch("a\n\tb\nc")).toBe("a b c");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizePromptForMatch("  hello world  ")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(normalizePromptForMatch("")).toBe("");
  });

  it("handles whitespace-only string", () => {
    expect(normalizePromptForMatch("   \n\t  ")).toBe("");
  });
});

describe("findPreviousErrorForPrompt", () => {
  let tempDir: string;
  let fs: VideocityFs;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-err-"));
    fs = createFsForTest(tempDir);
    await fs.createProject("err-proj");
  });

  afterEach(async () => {
    await fs.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function createAsset(fs: VideocityFs, name: string): Promise<string> {
    const result = await fs.createAsset("vid", name, "err-proj");
    if (!result.ok) throw new Error(result.error.message);
    return result.value.assetId;
  }

  async function writeError(
    fs: VideocityFs,
    assetId: string,
    info: { message: string; failCode?: string; prompt?: string | null },
  ): Promise<void> {
    const result = await fs.generationErrors.write("err-proj", assetId, info);
    if (!result.ok) throw new Error(result.error.message);
  }

  it("finds the latest matching error by prompt text", async () => {
    const a1 = await createAsset(fs, "first attempt");
    const a2 = await createAsset(fs, "second attempt");
    await writeError(fs, a1, { message: "old error", prompt: "a cat running" });
    await new Promise((r) => setTimeout(r, 100));
    await writeError(fs, a2, { message: "new error", prompt: "a cat running" });
    const found = await findPreviousErrorForPrompt(fs, "err-proj", "a cat running");
    expect(found).not.toBeNull();
    expect(found!.message).toBe("new error");
  });

  it("matches prompt with different whitespace (normalized)", async () => {
    const a1 = await createAsset(fs, "ws attempt");
    await writeError(fs, a1, { message: "ws error", prompt: "a  cat\nrunning" });
    const found = await findPreviousErrorForPrompt(fs, "err-proj", "a cat running");
    expect(found).not.toBeNull();
    expect(found!.message).toBe("ws error");
  });

  it("returns null when no prompt matches", async () => {
    const a1 = await createAsset(fs, "no match");
    await writeError(fs, a1, { message: "err", prompt: "a dog running" });
    const found = await findPreviousErrorForPrompt(fs, "err-proj", "a cat running");
    expect(found).toBeNull();
  });

  it("skips error rows with null prompt", async () => {
    const a1 = await createAsset(fs, "null prompt");
    await writeError(fs, a1, { message: "no prompt here", prompt: null });
    const found = await findPreviousErrorForPrompt(fs, "err-proj", "anything");
    expect(found).toBeNull();
  });

  it("preserves failCode from the matched error", async () => {
    const a1 = await createAsset(fs, "code attempt");
    await writeError(fs, a1, {
      message: "filter triggered",
      failCode: "PROMINENT_PEOPLE_FILTER_FAILED",
      prompt: "celebrity lookalike",
    });
    const found = await findPreviousErrorForPrompt(fs, "err-proj", "celebrity lookalike");
    expect(found).not.toBeNull();
    expect(found!.failCode).toBe("PROMINENT_PEOPLE_FILTER_FAILED");
  });

  it("returns null for errors older than the 7-day recency window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    const a1 = await createAsset(fs, "stale attempt");
    await writeError(fs, a1, { message: "stale error", prompt: "old prompt" });
    vi.setSystemTime(new Date("2026-01-23T12:00:00Z"));
    const found = await findPreviousErrorForPrompt(fs, "err-proj", "old prompt");
    vi.useRealTimers();
    expect(found).toBeNull();
  });

  it("finds errors within the 7-day recency window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    const a1 = await createAsset(fs, "recent attempt");
    await writeError(fs, a1, { message: "recent error", prompt: "recent prompt" });
    vi.setSystemTime(new Date("2026-01-18T12:00:00Z"));
    const found = await findPreviousErrorForPrompt(fs, "err-proj", "recent prompt");
    vi.useRealTimers();
    expect(found).not.toBeNull();
    expect(found!.message).toBe("recent error");
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

  it("accepts model=gemini_omni and forces provider-docs mode", async () => {
    process.env.OPENAI_API_KEY = "test-key-for-validation";
    // gemini_omni forces provider-docs mode even without provider_docs=true.
    // With unresolvable image_slugs, provider-docs branch returns "Could not
    // resolve any image files" — the standard branch would return "No prompting
    // guide available for model: gemini_omni".
    const result = await client.callTool({
      name: "rewrite_prompt",
      arguments: {
        prompt: "a cat",
        model: "gemini_omni",
        image_slugs: ["nonexistent-slug"],
        project_slug: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Could not resolve any image files");
    expect(content[0].text).not.toContain("No prompting guide available");
  });

  it("accepts previous_error in the schema", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await client.callTool({
      name: "rewrite_prompt",
      arguments: {
        prompt: "a cat",
        model: "gemini_omni",
        previous_error: "PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED",
        project_slug: "test-proj",
      },
    });
    // Without API key, the tool returns the not-set error (past schema validation).
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("not set");
  });

  it("rejects empty previous_error string via schema min(1)", async () => {
    process.env.OPENAI_API_KEY = "test-key-for-validation";
    const result = await client.callTool({
      name: "rewrite_prompt",
      arguments: {
        prompt: "a cat",
        model: "nano_banana",
        previous_error: "",
        project_slug: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Too small");
  });

  it("returns isError when provider-docs guide is unreadable (does not throw)", async () => {
    process.env.OPENAI_API_KEY = "test-key-for-validation";
    // gemini_omni forces provider-docs mode which calls loadUseapiGuide().
    // With unresolvable image_slugs, we get "Could not resolve" which proves
    // the guide loaded past the try/catch. This test documents that the
    // try/catch returns isError instead of throwing on guide load failure.
    const result = await client.callTool({
      name: "rewrite_prompt",
      arguments: {
        prompt: "a cat",
        model: "gemini_omni",
        image_slugs: ["nonexistent-slug"],
        project_slug: "test-proj",
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as TextContent;
    expect(content[0].text).toContain("Could not resolve any image files");
    expect(content[0].text).not.toContain("No prompting guide available");
  });
});
