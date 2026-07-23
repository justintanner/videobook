import { describe, it, expect } from "vitest";
import {
  getRoutableTool,
  buildChatRoutingPrompt,
  ROUTABLE_TOOLS,
  NESTED_TIMESTAMP_PARAMS,
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
    expect(tool!.actualTool).toBe("prepare_video_generation");
    expect(tool!.category).toBe("generation");
  });

  it("returns timewarp routing parameters", () => {
    const tool = getRoutableTool("timewarp_video");
    expect(tool).toBeDefined();
    expect(tool!.actualTool).toBe("timewarp_video");
    expect(tool!.category).toBe("action");
    expect(tool!.params).toEqual([
      "asset_id",
      "start_seconds",
      "end_seconds",
      "stretch_factor",
    ]);
  });

  it("returns audio sync routing parameters", () => {
    const tool = getRoutableTool("sync_video_to_audio");
    expect(tool).toBeDefined();
    expect(tool!.actualTool).toBe("sync_video_to_audio");
    expect(tool!.category).toBe("action");
    expect(tool!.params).toEqual(["asset_id", "anchors"]);
  });

  it("returns correct tool info for generate_image", () => {
    const tool = getRoutableTool("generate_image");
    expect(tool).toBeDefined();
    expect(tool!.actualTool).toBe("generate_kie_nano_banana_pro_text_to_image");
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

  it("returns QR outro routing parameters", () => {
    const tool = getRoutableTool("create_qr_outro");
    expect(tool).toBeDefined();
    expect(tool!.actualTool).toBe("create_qr_outro");
    expect(tool!.category).toBe("action");
    expect(tool!.params).toEqual([
      "qr_image_slugs",
      "sound_effect_slug",
      "aspect_ratio",
    ]);
  });

  it("returns undefined for nonexistent tool", () => {
    expect(getRoutableTool("nonexistent")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(getRoutableTool("")).toBeUndefined();
  });

  it("routes safe Videobook notebook and entity operations", () => {
    expect(getRoutableTool("create_notebook")?.actualTool).toBe("create_notebook");
    expect(getRoutableTool("run_notebook")?.params).toEqual(["notebook_id"]);
    expect(getRoutableTool("create_prompt")?.actualTool).toBe("create_prompt");
    expect(getRoutableTool("create_character_entity")?.actualTool)
      .toBe("create_character_entity");
    expect(getRoutableTool("create_scene")?.actualTool).toBe("create_scene");
    expect(getRoutableTool("revision_history")?.actualTool)
      .toBe("revision_history");
  });

  it("does not route destructive Videobook operations from free text", () => {
    expect(getRoutableTool("delete_notebook")).toBeUndefined();
    expect(getRoutableTool("delete_prompt")).toBeUndefined();
    expect(getRoutableTool("storage_sync")).toBeUndefined();
    expect(getRoutableTool("rewind_project")).toBeUndefined();
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
    expect(prompt).toContain("create_watermark_card");
    expect(prompt).toContain("concat_images");
    expect(prompt).toContain("create_qr_outro");
    expect(prompt).toContain("timewarp_video");
    expect(prompt).toContain("sync_video_to_audio");
    expect(prompt).toContain("Available tools:");
  });

  it("guides QR requests to create_watermark_card not generate_image", () => {
    const prompt = buildChatRoutingPrompt("test");
    expect(prompt).toContain("create_watermark_card");
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

  it("has entries for timewarp_video", () => {
    expect(TIMESTAMP_PARAMS.timewarp_video).toEqual(["start_seconds", "end_seconds"]);
  });

  it("has nested timestamp entries for sync_video_to_audio", () => {
    expect(NESTED_TIMESTAMP_PARAMS.sync_video_to_audio).toEqual({
      anchors: ["video_seconds", "audio_seconds"],
    });
  });

  it("does not have entries for tools without timestamps", () => {
    expect(TIMESTAMP_PARAMS.reverse_video).toBeUndefined();
    expect(TIMESTAMP_PARAMS.generate_image).toBeUndefined();
  });
});

describe("ROUTABLE_TOOLS", () => {
  it("has the expected number of entries", () => {
    expect(ROUTABLE_TOOLS.length).toBe(50);
  });

  it("includes inject_first_frame for image-to-video routing", () => {
    const tool = getRoutableTool("inject_first_frame");
    expect(tool).toBeDefined();
    expect(tool!.actualTool).toBe("inject_first_frame");
    expect(tool!.params).toEqual(["target_asset_id", "image_asset_id", "orientation"]);
  });

  it("includes create_watermark_card for QR/watermark routing", () => {
    const tool = getRoutableTool("create_watermark_card");
    expect(tool).toBeDefined();
    expect(tool!.actualTool).toBe("create_watermark_card");
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
    const noParamTools = new Set([
      "render_timeline",
      "list_elevenlabs_voices",
      "clean_failed_assets",
      "list_notebooks",
      "list_prompts",
      "list_characters",
      "list_scenes",
      "list_jobs",
      "storage_status",
    ]);
    for (const tool of ROUTABLE_TOOLS) {
      if (noParamTools.has(tool.name)) continue;
      expect(tool.params.length).toBeGreaterThan(0);
    }
  });
});
