import { describe, expect, it } from "vitest";
import type { CostHints } from "@apicity/cost";
import { FAL_ENDPOINT_REQUEST_SCHEMAS } from "@apicity/fal/zod";
import { MediaGenerationRequestSchema } from "@apicity/kie/zod";
import { MACHGEN_IMAGE_SURFACES, MachGenGenerateRequestSchema } from "@apicity/machgen";
import { WaveSpeedSkyworkAiSkyreelsV4ImageToVideoRequestSchema } from "@apicity/wavespeed/zod";
import type { ZodType } from "zod";
import { resolveModel } from "./descriptor.js";
import { buildWireRequest, type WireRequestInput } from "./request.js";
import { estimateGeneration } from "./cost.js";
import { modelFrontierRankings } from "./frontier.js";
import { applyPromptDialect } from "./prompt-dialects.js";
import type { MediaRefs, Operation } from "./types.js";

const IMAGE = "https://example.com/image.png";
const IMAGE_2 = "https://example.com/image2.png";
const LAST = "https://example.com/last.png";
const VIDEO = "https://example.com/video.mp4";
const AUDIO = "https://example.com/voice.mp3";
const IMAGE_ID = "01890f1c-0000-7000-8000-0000000000aa";
const IMAGE_ID_2 = "01890f1c-0000-7000-8000-0000000000bb";

function build(id: string, call: WireRequestInput): Record<string, unknown> {
  const built = buildWireRequest(resolveModel(id), call);
  if (!built.ok) throw new Error(built.error);
  return built.request;
}

function refusal(id: string, call: WireRequestInput): string {
  const built = buildWireRequest(resolveModel(id), call);
  return built.ok ? "" : built.error;
}

function optionsOf(id: string): Record<string, { defaultValue?: unknown; enumValues: Array<string | number> }> {
  return Object.fromEntries(resolveModel(id).options.map((option) => [option.name, option]));
}

async function estimate(id: string, call: WireRequestInput, hints: CostHints = {}): Promise<{ usd: number; warnings: string[] }> {
  const result = await estimateGeneration(resolveModel(id), call, hints);
  if (!result.ok) throw new Error(result.error);
  return { usd: result.estimate.usd, warnings: result.estimate.warnings };
}

function boards(id: string): Array<[string, number]> {
  return modelFrontierRankings(id).map((ranking) => [ranking.type, ranking.rank]);
}

const KIE_CASES: [string, readonly Operation[], MediaRefs][] = [
  ["kling-4-0/image", ["text_to_image", "edit_image"], {}],
  ["gpt-image-2-6/economy-text-to-image", ["text_to_image"], {}],
  ["gpt-image-2-6/economy-image-to-image", ["edit_image"], { image: [IMAGE] }],
  ["grok-imagine-image-2-0/image-edit", ["edit_image"], { image: [IMAGE] }],
  ["bytedance/seedance-2-5-flash", ["text_to_video", "image_to_video", "reference_to_video"], {}],
  ["ltx/2-5-fast-text-to-video", ["text_to_video"], {}],
  ["ltx/2-5-fast-image-to-video", ["image_to_video"], { first_frame: [IMAGE] }],
  ["ltx/2-5-fast-audio-to-video", ["lip_sync"], { audio: [AUDIO] }],
  ["ltx/2-5-pro-text-to-video", ["text_to_video"], {}],
  ["ltx/2-5-pro-image-to-video", ["image_to_video"], { first_frame: [IMAGE] }],
];

describe("kie 0.29.0 catalog", () => {
  it.each(KIE_CASES)("%s builds a createTask request apicity's schema accepts and @apicity/cost prices", async (apiId, operations, refUrls) => {
    const id = `kie:${apiId}`;
    const model = resolveModel(id);
    expect(model.entry.operations).toEqual(operations);
    expect(model.entry.hidden).toBeUndefined();
    const call = { prompt: "a red fox runs through snow", refUrls };
    const request = build(id, call);
    expect(request.model).toBe(apiId);
    expect(MediaGenerationRequestSchema.safeParse(request).success).toBe(true);
    const hints = apiId === "ltx/2-5-fast-audio-to-video" ? { durationSeconds: 8 } : {};
    const priced = await estimate(id, call, hints);
    expect(priced.warnings).toEqual([]);
    expect(priced.usd).toBeGreaterThan(0);
  });

  it("sends Kling 4.0 Image references as @image_N, ranks it on both image boards and prices each reference", async () => {
    const id = "kie:kling-4-0/image";
    expect(resolveModel(id).slots).toEqual([expect.objectContaining({ role: "image", field: "image_urls", min: 0, max: 10 })]);
    expect(optionsOf(id)).toMatchObject({ resolution: { enumValues: ["2k", "4k", "8k"], defaultValue: "2k" }, aspect_ratio: { defaultValue: "9:16" } });
    expect(applyPromptDialect(resolveModel(id).entry.dialect, "put the hat from @image2 on @image1", { image: [IMAGE_ID, IMAGE_ID_2] }))
      .toBe("put the hat from @image_2 on @image_1");
    expect(refusal(id, { prompt: "a set", options: { mode: "series" } })).toMatch(/series mode requires count/u);
    const text = await estimate(id, { prompt: "a fox" });
    const edit = await estimate(id, { prompt: "a fox", refUrls: { image: [IMAGE, IMAGE_2] } });
    expect(edit.usd).toBeGreaterThan(text.usd);
    expect(boards(id)).toEqual([["t2i", 7], ["i2i", 6]]);
  });

  it("keeps GPT Image 2.6 Economy on PNG with KIE's aspect ratio always sent", () => {
    for (const id of ["kie:gpt-image-2-6/economy-text-to-image", "kie:gpt-image-2-6/economy-image-to-image"]) {
      const options = optionsOf(id);
      for (const name of ["output_format", "frame_count", "frame_duration_ms"]) expect(options[name], `${id} ${name}`).toBeUndefined();
      expect(options.aspect_ratio).toMatchObject({ defaultValue: "9:16" });
    }
    expect(build("kie:gpt-image-2-6/economy-text-to-image", { prompt: "a fox" })).toEqual({
      model: "gpt-image-2-6/economy-text-to-image",
      input: { prompt: "a fox", aspect_ratio: "9:16", background: "auto", output_format: "png", frame_count: "auto", frame_duration_ms: "auto" },
    });
    expect(build("kie:gpt-image-2-6/economy-image-to-image", { prompt: "night", refUrls: { image: [IMAGE] } }).input)
      .toMatchObject({ input_urls: [IMAGE], output_format: "png" });
  });

  it("catalogs KIE's new Grok Imagine Image 2.0 edit of one to five images by URL", () => {
    const id = "kie:grok-imagine-image-2-0/image-edit";
    expect(resolveModel(id).slots).toEqual([expect.objectContaining({ role: "image", field: "image_urls", min: 1, max: 5 })]);
    expect(build(id, { prompt: "make it night", refUrls: { image: [IMAGE, IMAGE_2] } })).toEqual({
      model: "grok-imagine-image-2-0/image-edit",
      input: { prompt: "make it night", aspect_ratio: "9:16", image_urls: [IMAGE, IMAGE_2] },
    });
    expect(refusal(id, { prompt: "x", refUrls: { image: Array.from({ length: 6 }, () => IMAGE) } })).toMatch(/at most 5 image refs/u);
  });

  it("runs Seedance 2.5 Flash at 480p or 720p and keeps the KIE Seedance 2.5 default at 1080p despite its new 4k tier", () => {
    const flash = "kie:bytedance/seedance-2-5-flash";
    expect(optionsOf(flash).resolution).toMatchObject({ enumValues: ["480p", "720p"], defaultValue: "720p" });
    expect(resolveModel(flash).slots.map((slot) => [slot.role, slot.max])).toEqual([["first_frame", 1], ["last_frame", 1], ["image", 10], ["video", 5], ["audio", 5]]);
    expect(build(flash, { prompt: "the cat blinks", refUrls: { first_frame: [IMAGE] }, mode: "i2v" }).input).toMatchObject({ first_frame_url: IMAGE, aspect_ratio: "adaptive" });
    expect(optionsOf("kie:bytedance/seedance-2-5").resolution).toMatchObject({ enumValues: ["480p", "720p", "1080p", "4k"], defaultValue: "1080p" });
  });

  it("pins LTX 2.5 Fast to 1080p so its 12 s default stays inside KIE's 10 s limit at 1440p", () => {
    for (const id of ["kie:ltx/2-5-fast-text-to-video", "kie:ltx/2-5-fast-image-to-video"]) {
      const refUrls = id.endsWith("image-to-video") ? { first_frame: [IMAGE] } : {};
      expect(optionsOf(id).resolution).toMatchObject({ enumValues: ["720p", "1080p", "1440p"], defaultValue: "1080p" });
      expect(build(id, { prompt: "a fox", refUrls }).input).toMatchObject({ resolution: "1080p", duration: 12, fps: 24 });
      expect(refusal(id, { prompt: "a fox", refUrls, options: { resolution: "1440p" } })).toMatch(/only 6, 8 or 10 seconds at 1440p/u);
    }
    expect(optionsOf("kie:ltx/2-5-pro-text-to-video").duration).toMatchObject({ enumValues: [6, 8, 10], defaultValue: 10 });
    expect(resolveModel("kie:ltx/2-5-fast-image-to-video").slots).toEqual([expect.objectContaining({ role: "first_frame", field: "image_url", min: 1 })]);
  });

  it("follows the audio of an LTX 2.5 Fast audio-to-video and prices the seconds it renders", async () => {
    const id = "kie:ltx/2-5-fast-audio-to-video";
    const model = resolveModel(id);
    expect(model.entry).toMatchObject({ outputLength: "audio" });
    expect(model.slots.map((slot) => [slot.role, slot.field, slot.min])).toEqual([["first_frame", "image_url", 0], ["audio", "audio_url", 1]]);
    expect(build(id, { prompt: "she sings", refUrls: { audio: [AUDIO], first_frame: [IMAGE] } }).input)
      .toEqual({ audio_url: AUDIO, image_url: IMAGE, prompt: "she sings", resolution: "1080p", fps: 24 });
    expect((await estimate(id, { prompt: "she sings", refUrls: { audio: [AUDIO] } })).warnings.join(" ")).toContain("durationSeconds");
  });
});

const FAL_CASES: [string, readonly Operation[], MediaRefs, Array<[string, number]>][] = [
  ["microsoft/mai-image-2.7/text-to-image", ["text_to_image"], {}, [["t2i", 4]]],
  ["microsoft/mai-image-2.7/edit", ["edit_image"], { image: [IMAGE] }, [["i2i", 1]]],
  ["microsoft/mai-image-2.7/flash/edit", ["edit_image"], { image: [IMAGE] }, [["i2i", 7]]],
];

describe("fal MAI Image 2.7", () => {
  it.each(FAL_CASES)("%s builds a request fal's schema accepts, ranks on its board and waits for fal's billed tokens", async (apiId, operations, refUrls, ranks) => {
    const id = `fal:${apiId}`;
    expect(resolveModel(id).entry.operations).toEqual(operations);
    const request = build(id, { prompt: "a red kite", refUrls });
    const schemas = FAL_ENDPOINT_REQUEST_SCHEMAS as unknown as Record<string, ZodType>;
    expect(schemas[apiId]!.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({ resolution: "2K", output_format: "png" });
    expect(boards(id)).toEqual(ranks);
    expect(refusal(id, { prompt: "a kite", refUrls, options: { background: "transparent", output_format: "jpeg" } }))
      .toBe("Background: a transparent background needs png or webp output");
    const priced = await estimate(id, { prompt: "a red kite", refUrls });
    expect(priced.usd).toBe(0);
    expect(priced.warnings.join(" ")).toContain("x-fal-billable-units");
  });

  it("takes one to five edit images", () => {
    expect(resolveModel("fal:microsoft/mai-image-2.7/edit").slots).toEqual([expect.objectContaining({ role: "image", field: "image_urls", min: 1, max: 5 })]);
  });
});

describe("MachGen 0.29.0 catalog", () => {
  it("offers Gemini Omni 1.2 Flash text, frames and references with MachGen's edit and extend caps", async () => {
    const id = "machgen:Gemini-Omni-1.2-Flash";
    const model = resolveModel(id);
    expect(model.entry.operations).toEqual(["text_to_video", "image_to_video", "reference_to_video"]);
    expect(model.slots.map((slot) => [slot.role, slot.max])).toEqual([["first_frame", 1], ["last_frame", 1], ["image", 6], ["video", 3]]);
    expect(optionsOf(id)).toMatchObject({
      resolution: { enumValues: ["360p", "720p", "1080p", "2160p"], defaultValue: "2160p" },
      reference_video_operation: { enumValues: ["reference", "edit", "extend"] },
    });
    expect(build(id, { prompt: "the cat turns", refUrls: { first_frame: [IMAGE], last_frame: [LAST] }, options: { resolution: "720p" }, mode: "i2v" })).toEqual({
      model: "Gemini-Omni-1.2-Flash", task_type: "I2V", prompt: "the cat turns", src_image_urls: [IMAGE, LAST],
      video_config: { height: 720, duration_secs: 10, aspect_ratio: "9:16" },
    });
    expect(refusal(id, { prompt: "x", refUrls: { first_frame: [IMAGE], last_frame: [LAST] }, options: { duration: 12 }, mode: "i2v" }))
      .toMatch(/a first and last frame allow at most 10 seconds/u);
    const edit = { prompt: "make it snow", refUrls: { video: [VIDEO], image: [IMAGE, IMAGE_2, IMAGE] }, options: { reference_video_operation: "edit" }, mode: "r2v" };
    expect(refusal(id, edit)).toMatch(/edit takes at most 2 reference images/u);
    const extend = { prompt: "keep going", refUrls: { video: [VIDEO, VIDEO] }, options: { reference_video_operation: "extend" }, mode: "r2v" };
    expect(refusal(id, extend)).toMatch(/extend takes at most 1 reference video/u);
    const request = build(id, { prompt: "make it snow", refUrls: { video: [VIDEO], image: [IMAGE] }, options: { reference_video_operation: "edit", resolution: "720p", duration: 5 }, mode: "r2v" });
    expect(MachGenGenerateRequestSchema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({ task_type: "R2V", src_video_urls: [VIDEO], reference_video_operation: "edit" });
    expect((await estimate(id, { prompt: "a boat", options: { resolution: "720p", duration: 5 } })).usd).toBeCloseTo(5 * 0.069504, 9);
    expect(boards(id)).toEqual([["t2v", 7], ["v2v", 2], ["r2v", 4]]);
  });

  it("sizes Seedream 5.5 within MachGen's pixel range and prices the tier and each source", async () => {
    const id = "machgen:Seedream-5.5";
    expect(optionsOf(id)).toMatchObject({
      aspect_ratio: { enumValues: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"], defaultValue: "9:16" },
      resolution: { enumValues: ["1K", "2K"], defaultValue: "2K" },
    });
    expect(resolveModel(id).slots).toEqual([expect.objectContaining({ role: "image", min: 0, max: 10 })]);
    expect(build(id, { prompt: "a watercolor cat", refUrls: { image: [IMAGE] }, options: { aspect_ratio: "1:1", resolution: "1K" } })).toEqual({
      model: "Seedream-5.5", task_type: "I2I", prompt: "a watercolor cat", image_config: { width: 1024, height: 1024 }, src_image_urls: [IMAGE],
    });
    expect((await estimate(id, { prompt: "a cat", refUrls: { image: [IMAGE] }, options: { aspect_ratio: "1:1", resolution: "1K" } })).usd).toBeCloseTo(0.028, 9);
    expect((await estimate(id, { prompt: "a cat" })).usd).toBeCloseTo(0.035, 9);
    expect(boards(id)).toEqual([["i2i", 8]]);
  });

  it("sends Hyperflow H3 and Pika H3 Flex as MiniMax H3 Turbo with MachGen's adapter", async () => {
    for (const [adapter, title, ranks] of [["hyperflow", "Hyperflow H3 (MachGen)", [["t2v", 5], ["i2v", 7], ["v2v", 3]]], ["pika_h3_flex", "Pika H3 Flex (MachGen)", [["i2v", 10], ["v2v", 10]]]] as const) {
      const id = `machgen:MiniMax-H3-Turbo/${adapter}`;
      expect(resolveModel(id).title).toBe(title);
      expect(optionsOf(id).resolution).toMatchObject({ enumValues: ["480p", "768p"] });
      const request = build(id, { prompt: "a red boat", options: { resolution: "768p", duration: 5 } });
      expect(request).toMatchObject({ model: "MiniMax-H3-Turbo", adapter, task_type: "T2V", video_config: { height: 768, duration_secs: 5 } });
      expect(MachGenGenerateRequestSchema.safeParse(request).success).toBe(true);
      expect((await estimate(id, { prompt: "a red boat", options: { resolution: "768p", duration: 5 } })).usd).toBeCloseTo(5 * 0.015, 9);
      expect(boards(id)).toEqual(ranks);
    }
    expect(build("machgen:MiniMax-H3-Turbo", { prompt: "a red boat" })).not.toHaveProperty("adapter");
  });

  it("keeps MachGen's private 540p and 1080p MiniMax H3 heights out of the picker", () => {
    expect(optionsOf("machgen:MiniMax-H3").resolution).toMatchObject({ enumValues: ["480p", "768p", "1440p"] });
    expect(optionsOf("machgen:MiniMax-H3-Turbo").resolution).toMatchObject({ enumValues: ["480p", "768p"] });
  });

  it("reads GPT Image 2.6 qualities from MACHGEN_IMAGE_SURFACES and leaves out auto, which @apicity/cost cannot price", () => {
    for (const apiId of ["GPT-Image-2.6-Sunburst", "GPT-Image-2.6-Flare"] as const) {
      const offered = MACHGEN_IMAGE_SURFACES[apiId].T2I.qualities.filter((quality) => quality !== "auto");
      expect(optionsOf(`machgen:${apiId}`).quality).toMatchObject({ enumValues: offered, defaultValue: "high" });
    }
    expect(MACHGEN_IMAGE_SURFACES["GPT-Image-2"].T2I.qualities).not.toContain("xhigh");
    expect(optionsOf("machgen:GPT-Image-2").quality).toMatchObject({ enumValues: ["high", "low"] });
    expect(build("machgen:GPT-Image-2", { prompt: "a kite", options: { quality: "low" } })).not.toHaveProperty("image_output");
  });
});

describe("WaveSpeed SkyReels V4 image-to-video", () => {
  it("takes a first frame, an optional last frame and up to six middle keyframes, and refuses fast mode with sound", async () => {
    const id = "wavespeed:skywork-ai/skyreels-v4/image-to-video";
    const model = resolveModel(id);
    expect(model.title).toBe("SkyReels V4 Image (WaveSpeed)");
    expect(model.slots.map((slot) => [slot.role, slot.field, slot.label, slot.min, slot.max])).toEqual([
      ["first_frame", "image", "First frame", 1, 1],
      ["last_frame", "last_image", "Last frame", 0, 1],
      ["keyframe", "images", "Keyframes", 0, 6],
    ]);
    const request = build(id, { prompt: "the fox leaps", refUrls: { first_frame: [IMAGE], keyframe: [IMAGE_2], last_frame: [LAST] }, options: { duration: 8 }, mode: "i2v" });
    expect(request).toEqual({ prompt: "the fox leaps", image: IMAGE, last_image: LAST, images: [IMAGE_2], duration: 8, resolution: "1080p" });
    expect(WaveSpeedSkyworkAiSkyreelsV4ImageToVideoRequestSchema.safeParse(request).success).toBe(true);
    expect(refusal(id, { prompt: "x", refUrls: { first_frame: [IMAGE] }, options: { mode: "fast", sound: true }, mode: "i2v" })).toBe("Sound: fast mode can't generate sound");
    const priced = await estimate(id, { prompt: "the fox leaps", refUrls: { first_frame: [IMAGE] }, options: { duration: 8 }, mode: "i2v" });
    expect(priced.warnings).toEqual([]);
    expect(priced.usd).toBeGreaterThan(0);
    expect(boards(id)).toEqual([["i2v", 5]]);
  });
});
