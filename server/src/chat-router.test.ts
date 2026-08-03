import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import {
  CHAT_TOOL_ALIASES,
  NESTED_TIMESTAMP_PARAMS,
  TIMESTAMP_PARAMS,
  buildChatRoutingPrompt,
  buildChatRoutingUserMessage,
  buildRoutableTools,
  effectForTool,
  getRoutableTool,
} from "./chat-router.js";
import { closeEngineForTest, createEngineForTest } from "./fs.js";
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
      .filter((tool) => tool.name === tool.actualTool)
      .map((tool) => tool.name);
    const expectedNames = definitions
      .map((definition) => definition.name)
      .filter((name) => name !== "chat");
    expect(new Set(directNames)).toEqual(new Set(expectedNames));
    expect(tools).toHaveLength(expectedNames.length + CHAT_TOOL_ALIASES.length);
    expect(getRoutableTool(tools, "chat")).toBeUndefined();
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
    expect(downloadDefinition?.schema.start_time?.safeParse(30).success).toBe(true);
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
    expect(splitDefinition?.schema.chunk_a_end?.safeParse("15s").success).toBe(true);
    expect(extractDefinition?.schema.end_time?.safeParse("0:44").success).toBe(true);
    expect(splitDefinition?.annotations?.destructiveHint).toBe(false);
    expect(extractDefinition?.annotations?.destructiveHint).toBe(false);
  });

  it("publishes required parameters and enum domains to the router", () => {
    const tools = buildRoutableTools(definitions);
    const motionControl = getRoutableTool(
      tools,
      "generate_kie_kling_3_0_motion_control",
    );
    expect(motionControl?.requiredParams).toEqual([
      "character_image_slugs",
      "motion_video_slugs",
    ]);
    expect(motionControl?.constraints).toEqual([
      'mode="720p"|"1080p"',
      'character_orientation="video"|"image"',
      'background_source="input_video"|"input_image"',
    ]);
    const prompt = buildChatRoutingPrompt("my-book", tools);
    expect(prompt).toContain(
      'allowed: mode="720p"|"1080p", character_orientation="video"|"image", background_source="input_video"|"input_image"',
    );
    expect(prompt).toContain("Omit optional parameters");
  });

  it("keeps generic generation aliases", () => {
    const tools = buildRoutableTools(definitions);
    expect(getRoutableTool(tools, "generate_video")).toMatchObject({
      actualTool: "prepare_video_generation",
      category: "generation",
    });
    expect(getRoutableTool(tools, "generate_image")).toMatchObject({
      actualTool: "generate_kie_nano_banana_pro_text_to_image",
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
    expect(prompt).toContain("use trim_video only when the existing source should be changed in place");
    expect(prompt).not.toContain("\n- chat:");
  });

  it("requests JSON in the Responses API input message", () => {
    const input = buildChatRoutingUserMessage({
      query: "download the first 30 seconds",
      assetContext: [],
      imageFiles: [],
      videoFiles: [],
      scriptContents: [],
    });
    expect(input).toMatch(/\bJSON\b/u);
    expect(input).toContain("download the first 30 seconds");
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
