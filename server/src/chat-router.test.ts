import { describe, it, expect } from "vitest";
import {
  getRoutableTool,
  buildChatRoutingPrompt,
  ROUTABLE_TOOLS,
  TIMESTAMP_PARAMS,
} from "./chat-router.js";

describe("getRoutableTool", () => {
  it("returns correct tool info for trim_video", () => {
    const tool = getRoutableTool("trim_video");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("trim_video");
    expect(tool!.actualTool).toBe("trim_video");
    expect(tool!.category).toBe("action");
    expect(tool!.params).toContain("asset_id");
    expect(tool!.params).toContain("trim_start");
    expect(tool!.params).toContain("trim_end");
  });

  it("returns correct tool info for generate_video", () => {
    const tool = getRoutableTool("generate_video");
    expect(tool).toBeDefined();
    expect(tool!.actualTool).toBe("preview_video");
    expect(tool!.category).toBe("generation");
  });

  it("returns correct tool info for generate_image", () => {
    const tool = getRoutableTool("generate_image");
    expect(tool).toBeDefined();
    expect(tool!.actualTool).toBe("generate_nano_banana_image");
    expect(tool!.category).toBe("generation");
    expect(tool!.params).toContain("prompt");
    expect(tool!.params).toContain("image_slugs");
  });

  it("returns correct tool info for concat_images", () => {
    const tool = getRoutableTool("concat_images");
    expect(tool).toBeDefined();
    expect(tool!.actualTool).toBe("concat_images");
    expect(tool!.category).toBe("generation");
    expect(tool!.params).toContain("image_slugs");
    expect(tool!.params).toContain("layout");
  });

  it("returns undefined for nonexistent tool", () => {
    expect(getRoutableTool("nonexistent")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(getRoutableTool("")).toBeUndefined();
  });
});

describe("buildChatRoutingPrompt", () => {
  it("includes the project slug", () => {
    const prompt = buildChatRoutingPrompt("my-project");
    expect(prompt).toContain("Current project: my-project");
  });

  it("includes the tool list", () => {
    const prompt = buildChatRoutingPrompt("test");
    expect(prompt).toContain("trim_video");
    expect(prompt).toContain("download_video");
    expect(prompt).toContain("generate_video");
    expect(prompt).toContain("generate_image");
    expect(prompt).toContain("create_watermark");
    expect(prompt).toContain("concat_images");
    expect(prompt).toContain("Available tools:");
  });

  it("guides QR requests to create_watermark not generate_image", () => {
    const prompt = buildChatRoutingPrompt("test");
    expect(prompt).toContain("create_watermark");
    expect(prompt).toMatch(/real scannable QR/i);
    expect(prompt).toContain("source_url");
  });

  it("includes history context when provided", () => {
    const historyContext = "Recent conversation:\nUser: trim the video";
    const prompt = buildChatRoutingPrompt("test", historyContext);
    expect(prompt).toContain(historyContext);
    expect(prompt).toContain("resolve pronouns");
  });

  it("omits history block when no history context", () => {
    const prompt = buildChatRoutingPrompt("test");
    expect(prompt).not.toContain("resolve pronouns");
    expect(prompt).not.toContain("Recent conversation");
  });

  it("includes JSON response format instruction", () => {
    const prompt = buildChatRoutingPrompt("test");
    expect(prompt).toContain("Respond with JSON only");
  });
});

describe("TIMESTAMP_PARAMS", () => {
  it("has entries for trim_video", () => {
    expect(TIMESTAMP_PARAMS.trim_video).toBeDefined();
    expect(TIMESTAMP_PARAMS.trim_video).toContain("trim_start");
    expect(TIMESTAMP_PARAMS.trim_video).toContain("trim_end");
    expect(TIMESTAMP_PARAMS.trim_video).toContain("cut_start");
    expect(TIMESTAMP_PARAMS.trim_video).toContain("cut_end");
  });

  it("has entries for download_video", () => {
    expect(TIMESTAMP_PARAMS.download_video).toBeDefined();
    expect(TIMESTAMP_PARAMS.download_video).toContain("start_time");
    expect(TIMESTAMP_PARAMS.download_video).toContain("end_time");
  });

  it("does not have entries for tools without timestamps", () => {
    expect(TIMESTAMP_PARAMS.reverse_video).toBeUndefined();
    expect(TIMESTAMP_PARAMS.generate_image).toBeUndefined();
  });
});

describe("ROUTABLE_TOOLS", () => {
  it("has the expected number of entries", () => {
    expect(ROUTABLE_TOOLS.length).toBe(29);
  });

  it("includes create_watermark for QR/watermark routing", () => {
    const tool = getRoutableTool("create_watermark");
    expect(tool).toBeDefined();
    expect(tool!.actualTool).toBe("create_watermark");
    expect(tool!.category).toBe("action");
    expect(tool!.params).toContain("url");
    expect(tool!.params).toContain("handle");
  });

  it("contains both action and generation categories", () => {
    const categories = new Set(ROUTABLE_TOOLS.map((t) => t.category));
    expect(categories.has("action")).toBe(true);
    expect(categories.has("generation")).toBe(true);
  });

  it("has unique tool names", () => {
    const names = ROUTABLE_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every tool has non-empty params array (except tools that take no routing params)", () => {
    const noParamTools = new Set(["render_timeline", "list_elevenlabs_voices", "clear_failed_tasks"]);
    for (const tool of ROUTABLE_TOOLS) {
      if (noParamTools.has(tool.name)) continue;
      expect(tool.params.length).toBeGreaterThan(0);
    }
  });
});
