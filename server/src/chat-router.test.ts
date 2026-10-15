import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import {
  AUTO_APPLY_TOOL_NAMES,
  CHAT_TOOL_ALIASES,
  NESTED_TIMESTAMP_PARAMS,
  TIMESTAMP_PARAMS,
  applyBytedanceNamedModelRoute,
  applyStackedChainRoute,
  applyVideoJoinRoute,
  buildChatRoutingPrompt,
  buildChatRoutingUserMessage,
  buildRoutableTools,
  effectForTool,
  getRoutableTool,
} from "./chat-router.js";
import { CHAT_VIEW_ACTIONS } from "./chat-view-actions.js";
import { closeEngineForTest, createEngineForTest } from "./engine.js";
import { getAllToolDefs } from "./tools/index.js";
import type { ToolDef } from "./tools/tool-def.js";

describe("chat routing catalog", () => {
  let root: string;
  let engine: Engine;
  let definitions: ToolDef[];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-chat-router-"));
    engine = createEngineForTest(root);
    definitions = getAllToolDefs(engine);
  });

  afterAll(async () => {
    closeEngineForTest(root, engine);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("exposes every registered tool except chat itself", () => {
    const tools = buildRoutableTools(definitions);
    const directNames = tools
      .filter((tool) => tool.name === tool.actualTool && tool.effect !== "view")
      .map((tool) => tool.name);
    const expectedNames = definitions
      .map((definition) => definition.name)
      .filter((name) => name !== "chat");
    expect(new Set(directNames)).toEqual(new Set(expectedNames));
    expect(tools).toHaveLength(
      expectedNames.length + CHAT_TOOL_ALIASES.length + CHAT_VIEW_ACTIONS.length,
    );
    expect(getRoutableTool(tools, "chat")).toBeUndefined();
    expect(getRoutableTool(tools, "chain")?.actualTool).toBe("chain");
    expect(getRoutableTool(tools, "chain")?.autoApply).toBe(false);
    expect(getRoutableTool(tools, "splice_video")?.params).toContain(
      "additional_asset_ids",
    );
    expect(getRoutableTool(tools, "splice_video")?.requiredParams).toEqual([
      "first_asset_id",
      "second_asset_id",
    ]);
  });

  it("offers app-side views beside the registered tools, with nothing to review", () => {
    const tools = buildRoutableTools(definitions);
    expect(definitions.map((definition) => definition.name))
      .not.toContain("show_media_fullscreen");
    expect(getRoutableTool(tools, "show_media_fullscreen")).toMatchObject({
      actualTool: "show_media_fullscreen",
      category: "action",
      effect: "view",
      autoApply: true,
      params: ["asset_id"],
      requiredParams: ["asset_id"],
    });
    const prompt = buildChatRoutingPrompt("my-book", tools);
    expect(prompt).toContain("- show_media_fullscreen: Show, open, view or enlarge");
    expect(prompt).toContain("- For show_media_fullscreen: use when the user asks to show, open, view, or enlarge");
  });

  it("includes registered destructive and administrative tools", () => {
    const tools = buildRoutableTools(definitions);
    expect(getRoutableTool(tools, "delete_notebook")?.actualTool)
      .toBe("delete_notebook");
    expect(getRoutableTool(tools, "storage_sync")?.actualTool)
      .toBe("storage_sync");
    expect(getRoutableTool(tools, "set_env_secret")?.actualTool)
      .toBe("set_env_secret");
  });

  it("derives parameters from registered schemas without book_id", () => {
    const tools = buildRoutableTools(definitions);
    const download = getRoutableTool(tools, "download_video");
    const downloadDefinition = definitions.find((definition) =>
      definition.name === "download_video");
    expect(download?.params).toContain("url");
    expect(download?.params).toContain("start_time");
    expect(download?.params).toContain("end_time");
    expect(download?.params).not.toContain("book_id");
    const startTime = downloadDefinition?.schema.start_time as
      { safeParse?: (value: unknown) => { success: boolean } } | undefined;
    expect(startTime?.safeParse?.(30).success).toBe(true);
  });

  it("publishes permissive source-preserving clip tools", () => {
    const tools = buildRoutableTools(definitions);
    const split = getRoutableTool(tools, "split_video");
    const extract = getRoutableTool(tools, "extract_video_clip");
    const splitDefinition = definitions.find((definition) =>
      definition.name === "split_video");
    const extractDefinition = definitions.find((definition) =>
      definition.name === "extract_video_clip");
    expect(split?.requiredParams).toEqual(["asset_id", "chunk_a_end"]);
    expect(extract?.requiredParams).toEqual(["asset_id", "end_time"]);
    const chunkEnd = splitDefinition?.schema.chunk_a_end as
      { safeParse?: (value: unknown) => { success: boolean } } | undefined;
    const endTime = extractDefinition?.schema.end_time as
      { safeParse?: (value: unknown) => { success: boolean } } | undefined;
    expect(chunkEnd?.safeParse?.("15s").success).toBe(true);
    expect(endTime?.safeParse?.("0:44").success).toBe(true);
    expect(splitDefinition?.annotations?.destructiveHint).toBe(false);
    expect(extractDefinition?.annotations?.destructiveHint).toBe(false);
  });

  it("publishes required parameters and enum domains to the router", () => {
    const tools = buildRoutableTools(definitions);
    const transformation = getRoutableTool(
      tools,
      "generate_kie_kling_3_0_omni_transformation",
    );
    expect(transformation?.requiredParams).toEqual([
      "prompt",
      "video_refs",
    ]);
    expect(transformation?.constraints).toEqual([
      'resolution="720p"|"1080p"|"4k"',
      'aspect_ratio="16:9"|"9:16"|"1:1"|"auto"',
    ]);
    const prompt = buildChatRoutingPrompt("my-book", tools);
    expect(prompt).toContain(
      'allowed: resolution="720p"|"1080p"|"4k", aspect_ratio="16:9"|"9:16"|"1:1"|"auto"',
    );
    expect(prompt).toContain("Omit optional parameters");
    const mediaSlot = getRoutableTool(tools, "set_notebook_media_slot");
    expect(mediaSlot?.requiredParams).toContain("artifact_ref");
    expect(mediaSlot?.params).toContain("artifact_ref");
    expect(prompt).toMatch(/set_notebook_media_slot[^\n]*required:[^\n]*artifact_ref/);
  });

  it("keeps generic generation aliases", () => {
    const tools = buildRoutableTools(definitions);
    expect(getRoutableTool(tools, "generate_video")).toMatchObject({
      actualTool: "generate_kie_seedance_2_5_video",
      category: "generation",
      effect: "generation",
      autoApply: false,
    });
    expect(getRoutableTool(tools, "generate_video")?.params).toEqual(
      expect.arrayContaining(["prompt", "duration", "aspect_ratio", "resolution"]),
    );
    expect(getRoutableTool(tools, "generate_image")).toMatchObject({
      actualTool: "generate_kie_nano_banana_2_1_image",
      category: "generation",
      effect: "generation",
    });
  });

  it("executes reads immediately and gates every other routed effect", () => {
    expect(effectForTool("list_assets", "action")).toBe("read");
    expect(effectForTool("plan_sequence_edit", "action")).toBe("read");
    expect(effectForTool("download_video", "action")).toBe("mutation");
    expect(effectForTool("delete_notebook", "action")).toBe("mutation");
    expect(effectForTool("generate_image", "generation")).toBe("generation");
  });

  it("marks free local extraction tools for auto-apply only", () => {
    const tools = buildRoutableTools(definitions);
    expect(AUTO_APPLY_TOOL_NAMES.has("duplicate_asset")).toBe(true);
    expect(AUTO_APPLY_TOOL_NAMES.has("extract_audio")).toBe(true);
    expect(AUTO_APPLY_TOOL_NAMES.has("extract_first_frame")).toBe(true);
    expect(AUTO_APPLY_TOOL_NAMES.has("extract_last_frame")).toBe(true);
    expect(AUTO_APPLY_TOOL_NAMES.has("extract_frame")).toBe(true);
    expect(getRoutableTool(tools, "extract_first_frame")).toMatchObject({
      effect: "mutation",
      autoApply: true,
    });
    expect(getRoutableTool(tools, "extract_last_frame")).toMatchObject({
      effect: "mutation",
      autoApply: true,
    });
    expect(getRoutableTool(tools, "extract_frame")).toMatchObject({
      effect: "mutation",
      autoApply: true,
    });
    expect(getRoutableTool(tools, "extract_audio")).toMatchObject({
      effect: "mutation",
      autoApply: true,
    });
    expect(getRoutableTool(tools, "duplicate_asset")).toMatchObject({
      effect: "mutation",
      autoApply: true,
    });
    expect(getRoutableTool(tools, "trim_video")?.autoApply).toBe(false);
    expect(getRoutableTool(tools, "split_video")?.autoApply).toBe(false);
    expect(getRoutableTool(tools, "prepare_cold_open")).toMatchObject({ effect: "mutation", autoApply: false });
    expect(getRoutableTool(tools, "post")).toMatchObject({
      effect: "mutation",
      autoApply: false,
    });
    expect(
      getRoutableTool(tools, "generate_kie_minimax_h3_text_to_video")?.autoApply,
    ).toBe(false);
    expect(getRoutableTool(tools, "chain")?.autoApply).toBe(false);
  });

  it("rewrites stacked extract-then-replace requests onto chain", () => {
    const routed = applyStackedChainRoute({
      query: "extract audio from b2 and use it to replace the audio on the video in c4",
      tool: "extract_audio",
      params: { asset_id: "@b2" },
      message: "Extracting audio.",
      assetContext: [],
      notebookContext: {
        id: "019fcc00-0000-7000-8000-0000000000aa",
        name: "Main",
        cells: [],
      },
    });
    expect(routed.tool).toBe("chain");
    expect(routed.substituted).toBe(true);
    expect(routed.params.steps).toEqual([
      { id: "extract", tool: "extract_audio", params: { asset_id: "@b2" } },
      {
        id: "replace",
        tool: "replace_video_audio",
        params: {
          asset_id: "@c4",
          audio_asset_id: {
            $ref: { step_id: "extract", output: "audio_asset_id" },
          },
        },
      },
    ]);
    const single = applyStackedChainRoute({
      query: "extract audio from @b2",
      tool: "extract_audio",
      params: { asset_id: "@b2" },
      message: "Extracting audio.",
      assetContext: [],
    });
    expect(single.substituted).toBe(false);
    expect(single.tool).toBe("extract_audio");
  });

  it("builds a prompt from the live catalog and conversation history", () => {
    const tools = buildRoutableTools(definitions);
    const prompt = buildChatRoutingPrompt(
      "my-book",
      tools,
      "Recent conversation:\nUser: download the clip",
    );
    expect(prompt).toContain("Current book: my-book");
    expect(prompt).toContain("Available tools:");
    expect(prompt).toContain("- download_video:");
    expect(prompt).toContain("- delete_notebook:");
    expect(prompt).toContain("Recent conversation:");
    expect(prompt).toContain("remaining/rest/remainder");
    expect(prompt).toContain("use extract_video_clip");
    expect(prompt).toContain("use prepare_cold_open");
    expect(prompt).toContain("use save_post_to_icloud");
    expect(prompt).toContain("Use upload_post_to_dropbox only when the user says Dropbox");
    expect(prompt).toContain("use trim_video only when the existing source should be changed in place");
    expect(prompt).toContain("For splice_video:");
    expect(prompt).toContain('{"id","tool","params"}');
    expect(prompt).toContain("id is required and unique");
    expect(prompt).toContain("additional_asset_ids");
    expect(prompt).toContain("media_context is an optional single object");
    expect(prompt).not.toContain("\n- chat:");
  });

  it("requests JSON in the Responses API input message", () => {
    const input = buildChatRoutingUserMessage({
      query: "download the first 30 seconds",
      assetContext: [],
      imageFiles: [],
      videoFiles: [],
      scriptContents: [],
      notebookContext: null,
    });
    expect(input).toMatch(/\bJSON\b/u);
    expect(input).toContain("download the first 30 seconds");
  });

  it("keeps routed generation prompts compact and preserves notebook roles", () => {
    const prompt = buildChatRoutingPrompt("my-book", buildRoutableTools(definitions));
    expect(prompt).toContain("For every image or video generation tool");
    expect(prompt).toContain("smart Caveman style");
    expect(prompt).toContain("drop filler, hedging, pleasantries, articles");
    expect(prompt).toContain("preserve the user's language plus exact names, technical terms, negation, numbers, units, and @addresses");
    expect(prompt).toContain("scene @a5, character @a1, fluffy kitten standing");
    expect(prompt).toContain("Preserve every consumed notebook @address");
    expect(prompt).toContain("same order");
    expect(prompt).toContain("Seedance is video, Seedream is image");
    expect(prompt).toContain("generate_kie_seedream_v5_lite_image_to_image");
    expect(prompt).toContain("edit-target image first");
    expect(prompt).toContain("generate_kie_seedance_2_5_video");
  });
});

describe("video join routing", () => {
  const clipIds = [
    "019fcc00-0000-7000-8000-000000000001",
    "019fcc00-0000-7000-8000-000000000002",
    "019fcc00-0000-7000-8000-000000000003",
    "019fcc00-0000-7000-8000-000000000004",
  ] as const;
  const notebookContext = {
    id: "019fcc00-0000-7000-8000-000000000010",
    name: "Main",
    cells: clipIds.map((artifactId, index) => ({
      address: `@a${index + 1}`,
      cellId: `019fcc00-0000-7000-8000-00000000002${index}`,
      type: "video",
      outputAsset: `@${artifactId}`,
    })),
  };

  it("reroutes a four-clip splice away from plan_chat_command media_context arrays", () => {
    const routed = applyVideoJoinRoute({
      query: "splice together these 4 video clips",
      tool: "plan_chat_command",
      params: {
        actor: "user",
        prompt: "splice together these 4 video clips",
        media_context: clipIds.map((artifact_id) => ({ artifact_id })),
      },
      message: "Planning chat command.",
      assetContext: [],
    });
    expect(routed.tool).toBe("splice_video");
    expect(routed.substituted).toBe(true);
    expect(routed.params).toEqual({
      first_asset_id: clipIds[0],
      second_asset_id: clipIds[1],
      additional_asset_ids: [clipIds[2], clipIds[3]],
      overlap: 0,
    });
  });

  it("uses notebook mention order for a concat request", () => {
    const routed = applyVideoJoinRoute({
      query: "concat @a1 @a2 @a3 @a4",
      tool: "plan_chat_command",
      params: { prompt: "concat @a1 @a2 @a3 @a4" },
      message: "",
      assetContext: [],
      notebookContext,
    });
    expect(routed.tool).toBe("splice_video");
    expect(routed.params.first_asset_id).toBe(clipIds[0]);
    expect(routed.params.second_asset_id).toBe(clipIds[1]);
    expect(routed.params.additional_asset_ids).toEqual([clipIds[2], clipIds[3]]);
    expect(routed.message).toBe("Splicing videos.");
  });

  it("does not steal apply_cuts or splice-out requests", () => {
    const routed = applyVideoJoinRoute({
      query: "splice out the silence from @a1 and @a2",
      tool: "apply_cuts",
      params: { asset_id: clipIds[0] },
      message: "Applying cuts.",
      assetContext: [],
      notebookContext,
    });
    expect(routed.tool).toBe("apply_cuts");
    expect(routed.substituted).toBe(false);
  });
});

describe("ByteDance named-model routing", () => {
  const actorAssets = [
    { tag: "@e2", type: "image", asset_id: "img-e2", notebook_references: ["e2"] },
    { tag: "@e1", type: "video", asset_id: "vid-e1", notebook_references: ["e1"] },
    { tag: "@d1", type: "image", asset_id: "img-d1", notebook_references: ["d1"] },
    { tag: "@d2", type: "image", asset_id: "img-d2", notebook_references: ["d2"] },
    { tag: "@d3", type: "image", asset_id: "img-d3", notebook_references: ["d3"] },
  ];

  it("routes a seedance-named image actor replacement to Seedream i2i with the edit target first", () => {
    const routed = applyBytedanceNamedModelRoute({
      query: "replace the three actors in @e2 with @d1 @d2 @d3 using seedance",
      tool: "generate_kie_seedance_2_5_video",
      params: {
        prompt: "replace the three actors",
        video_refs: ["@e2"],
        image_refs: ["@d1", "@d2", "@d3"],
      },
      message: "Generating video.",
      assetContext: actorAssets,
    });
    expect(routed.tool).toBe("generate_kie_seedream_v5_lite_image_to_image");
    expect(routed.params.image_refs).toEqual(["@e2", "@d1", "@d2", "@d3"]);
    expect(routed.substituted).toBe(true);
    expect(routed.message).toContain("Seedream");
    expect(routed.message).toContain("Seedance is video");
  });

  it("routes a video-target seedance replacement to Seedance 2.0 r2v", () => {
    const routed = applyBytedanceNamedModelRoute({
      query: "replace the three actors in @e1 with @d1 @d2 @d3 using seedance",
      tool: "generate_image",
      params: {
        prompt: "replace the three actors",
        image_refs: ["@e1", "@d1", "@d2", "@d3"],
      },
      message: "Generating image.",
      assetContext: actorAssets,
    });
    expect(routed.tool).toBe("generate_kie_seedance_2_5_video");
    expect(routed.params.video_refs).toEqual(["@e1"]);
    expect(routed.params.image_refs).toEqual(["@d1", "@d2", "@d3"]);
    expect(routed.substituted).toBe(false);
  });

  it("maps Seedance 5.0 edit on an image target to Seedream", () => {
    const routed = applyBytedanceNamedModelRoute({
      query: "edit @e2 with Seedance 5.0 edit using @d1",
      tool: "generate_image",
      params: { prompt: "edit the actors" },
      message: "Generating image.",
      assetContext: actorAssets,
    });
    expect(routed.tool).toBe("generate_kie_seedream_v5_lite_image_to_image");
    expect(routed.params.image_refs).toEqual(["@e2", "@d1"]);
  });
});

describe("chat timestamp parameters", () => {
  it("defines top-level timestamp fields", () => {
    expect(TIMESTAMP_PARAMS.trim_video).toEqual([
      "trim_start",
      "trim_end",
      "cut_start",
      "cut_end",
    ]);
    expect(TIMESTAMP_PARAMS.download_video).toEqual(["start_time", "end_time"]);
    expect(TIMESTAMP_PARAMS.split_video).toEqual(["chunk_a_end", "chunk_b_start"]);
    expect(TIMESTAMP_PARAMS.extract_video_clip).toEqual(["start_time", "end_time"]);
    expect(TIMESTAMP_PARAMS.timewarp_video).toEqual(["start_seconds", "end_seconds"]);
  });

  it("defines nested timestamp fields", () => {
    expect(NESTED_TIMESTAMP_PARAMS.sync_video_to_audio).toEqual({
      anchors: ["video_seconds", "audio_seconds"],
    });
  });
});
