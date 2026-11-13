import { describe, expect, it } from "vitest";
import type { CostHints } from "@apicity/cost";
import { MediaGenerationRequestSchema } from "@apicity/kie/zod";
import { resolveModel } from "./descriptor.js";
import { buildWireRequest, type WireRequestInput } from "./request.js";
import { estimateGeneration } from "./cost.js";
import { modelFrontierRankings } from "./frontier.js";
import { FRONTIER_CATALOG_GAPS } from "./frontier-gaps.js";
import { applyPromptDialect } from "./prompt-dialects.js";
import type { MediaRefs, Operation } from "./types.js";

const IMAGE = "https://example.com/image.png";
const IMAGE_2 = "https://example.com/image2.png";
const LAST = "https://example.com/last.png";
const MASK = "https://example.com/mask.png";
const MARKUP = "https://example.com/markup.png";
const VIDEO = "https://example.com/video.mp4";
const IMAGE_ID = "01890f1c-0000-7000-8000-0000000000aa";
const IMAGE_ID_2 = "01890f1c-0000-7000-8000-0000000000bb";
const VIDEO_ID = "01890f1c-0000-7000-8000-0000000000cc";
const FRAME_ID = "01890f1c-0000-7000-8000-0000000000dd";

const GEMINI = "kie:google/gemini-omni-flash-1-2";
const SUNBURST_EDIT = "kie:gpt-image-2-6/sunburst-image-to-image";

const cases: [string, readonly Operation[], MediaRefs][] = [
  ["gpt-image-2-6/sunburst-text-to-image", ["text_to_image"], {}],
  ["gpt-image-2-6/sunburst-image-to-image", ["edit_image"], { image: [IMAGE] }],
  ["gpt-image-2-6/flare-text-to-image", ["text_to_image"], {}],
  ["gpt-image-2-6/flare-image-to-image", ["edit_image"], { image: [IMAGE] }],
  ["seedream/5-5-text-to-image", ["text_to_image"], {}],
  ["seedream/5-5-image-to-image", ["edit_image"], { image: [IMAGE] }],
  ["seedream/5-5-layer-decomposition", ["layer_image"], { image: [IMAGE] }],
  ["minimax-h3/text-to-image", ["text_to_image"], {}],
  ["minimax-h3/image-edit", ["edit_image"], { image: [IMAGE] }],
  ["kie/image-upscale", ["edit_image"], { image: [IMAGE] }],
  ["video/upscale", ["upscale_video"], { video: [VIDEO] }],
  ["kling-4.0/flash-keyframe-to-video", ["image_to_video"], { first_frame: [IMAGE] }],
  ["kling-4.0/flash-reference-to-video", ["reference_to_video"], { image: [IMAGE], video: [VIDEO] }],
  ["google/gemini-omni-flash-1-2", ["text_to_video", "image_to_video", "reference_to_video", "edit_video"], {}],
];

function build(id: string, call: WireRequestInput): { model: string; input: Record<string, unknown> } {
  const built = buildWireRequest(resolveModel(id), call);
  if (!built.ok) throw new Error(built.error);
  return built.request as { model: string; input: Record<string, unknown> };
}

function refusal(id: string, call: WireRequestInput): string {
  const built = buildWireRequest(resolveModel(id), call);
  return built.ok ? "" : built.error;
}

function rewrite(id: string, prompt: string, refs: MediaRefs): string {
  return applyPromptDialect(resolveModel(id).entry.dialect, prompt, refs);
}

function optionsOf(id: string): Record<string, { defaultValue?: unknown; enumValues: Array<string | number> }> {
  return Object.fromEntries(resolveModel(id).options.map((option) => [option.name, option]));
}

async function estimate(id: string, call: WireRequestInput, hints: CostHints = {}): Promise<{ usd: number; warnings: string[] }> {
  const result = await estimateGeneration(resolveModel(id), call, hints);
  if (!result.ok) throw new Error(result.error);
  return { usd: result.estimate.usd, warnings: result.estimate.warnings };
}

describe("kie 0.28.0 catalog", () => {
  it.each(cases)("%s builds a createTask request apicity's schema accepts from a prompt and its required refs", (apiId, operations, refUrls) => {
    const model = resolveModel(`kie:${apiId}`);
    expect(model.entry.operations).toEqual(operations);
    expect(model.entry.hidden).toBeUndefined();
    const request = build(model.id, { prompt: model.promptField ? "a red fox in snow" : undefined, refUrls });
    expect(request.model).toBe(apiId);
    expect(MediaGenerationRequestSchema.safeParse(request).success).toBe(true);
  });

  it("offers Kie GPT Image 2.6 only the raster formats Videobook stores and keeps Kie's output rules", () => {
    for (const id of ["kie:gpt-image-2-6/sunburst-text-to-image", "kie:gpt-image-2-6/flare-image-to-image"]) {
      const options = optionsOf(id);
      expect(options.output_format).toMatchObject({ enumValues: ["jpeg", "png", "webp"], defaultValue: "png" });
      expect(options.quality).toMatchObject({ defaultValue: "high" });
      expect(options.complexity).toMatchObject({ enumValues: ["low", "medium", "high"], defaultValue: "high" });
      expect(options.resolution).toMatchObject({ enumValues: ["1K", "2K", "4K"], defaultValue: "2K" });
      for (const name of ["size", "frame_count", "frame_duration_ms", "svg"]) expect(options[name], `${id} ${name}`).toBeUndefined();
      const refUrls = id.endsWith("image-to-image") ? { image: [IMAGE] } : {};
      expect(refusal(id, { prompt: "a fox", refUrls, options: { output_format: "gif" } })).toMatch(/^Output format:/u);
      expect(refusal(id, { prompt: "a fox", refUrls, options: { output_format: "svg" } })).toMatch(/^Output format:/u);
      expect(refusal(id, { prompt: "a fox", refUrls, options: { background: "transparent", output_format: "jpeg" } }))
        .toBe("Background: background transparent needs output_format png, webp or gif");
      expect(refusal(id, { prompt: "a fox", refUrls, options: { output_compression: 80 } }))
        .toBe("Output compression: output_compression applies to jpeg and webp only; omit it for other formats");
    }
    const request = build("kie:gpt-image-2-6/sunburst-text-to-image", { prompt: "a fox", options: { background: "transparent", output_format: "webp" } });
    expect(request).toEqual({
      model: "gpt-image-2-6/sunburst-text-to-image",
      input: { prompt: "a fox", aspect_ratio: "9:16", resolution: "2K", quality: "high", background: "transparent", output_format: "webp", complexity: "high", moderation: "low" },
    });
  });

  it("sends Kie GPT Image 2.6 edit sources with a mask or a markup image, never both", () => {
    const model = resolveModel(SUNBURST_EDIT);
    expect(model.slots).toEqual([expect.objectContaining({ role: "image", field: "input_urls", min: 1, max: 16 })]);
    expect(model.fieldSlots.map(({ field, label, kind }) => ({ field, label, kind }))).toEqual([
      { field: "mask_url", label: "Mask", kind: "image" },
      { field: "markup", label: "Markup", kind: "image" },
    ]);
    const images = { image: [IMAGE, IMAGE_2] };
    expect(build(SUNBURST_EDIT, { prompt: "circle the hat", refUrls: images, fieldUrls: { markup: [MARKUP] } }).input)
      .toMatchObject({ input_urls: [IMAGE, IMAGE_2], markup: MARKUP });
    expect(build(SUNBURST_EDIT, { prompt: "repaint the sky", refUrls: images, fieldUrls: { mask_url: [MASK] } }).input)
      .toMatchObject({ input_urls: [IMAGE, IMAGE_2], mask_url: MASK });
    expect(refusal(SUNBURST_EDIT, { prompt: "x", refUrls: images, fieldUrls: { mask_url: [MASK], markup: [MARKUP] } }))
      .toBe("Markup: mask_url and markup cannot be used together");
    expect(refusal(SUNBURST_EDIT, { prompt: "x", refUrls: { image: Array.from({ length: 17 }, () => IMAGE) } })).toMatch(/at most 16 image refs/u);
    expect(rewrite(SUNBURST_EDIT, "put the hat from @image2 on @image1", { image: [IMAGE_ID, IMAGE_ID_2] }))
      .toBe("put the hat from reference image 2 on reference image 1");
  });

  it("leaves Kie GPT Image 2.6 unpriced before the task reports its tokens", async () => {
    for (const id of ["kie:gpt-image-2-6/flare-text-to-image", SUNBURST_EDIT]) {
      const refUrls = id === SUNBURST_EDIT ? { image: [IMAGE] } : {};
      const result = await estimate(id, { prompt: "a fox", refUrls });
      expect(result.usd).toBe(0);
      expect(result.warnings.join(" ")).toContain("imageOutputTokens");
    }
  });

  it("wires Seedream 5.5 sizes, its transparent PNG rule and its five-character prompts", async () => {
    expect(build("kie:seedream/5-5-text-to-image", { prompt: "a red fox" }).input)
      .toEqual({ prompt: "a red fox", aspect_ratio: "9:16", size: "2K", output_format: "png", background: "auto", nsfw_checker: false });
    expect(refusal("kie:seedream/5-5-text-to-image", { prompt: "fox" })).toMatch(/^Prompt:/u);
    expect(refusal("kie:seedream/5-5-text-to-image", { prompt: "a red fox", options: { background: "transparent", output_format: "jpeg" } }))
      .toBe("Background: background transparent is available only with output_format png");
    const edit = "kie:seedream/5-5-image-to-image";
    expect(build(edit, { prompt: "make it night", refUrls: { image: [IMAGE, IMAGE_2] } }).input).toMatchObject({ image_urls: [IMAGE, IMAGE_2], size: "2K" });
    expect(refusal(edit, { prompt: "make it night", refUrls: { image: Array.from({ length: 11 }, () => IMAGE) } })).toMatch(/at most 10 image refs/u);
    expect((await estimate("kie:seedream/5-5-text-to-image", { prompt: "a red fox" })).usd).toBeCloseTo(0.0315, 9);
    const twoImages = await estimate(edit, { prompt: "make it night", refUrls: { image: [IMAGE, IMAGE_2] }, options: { size: "1K" } });
    expect(twoImages).toEqual({ usd: expect.closeTo(0.018 + 2 * 0.0072, 9), warnings: [] });
  });

  it("splits one Seedream 5.5 image into capped layers and prices the cap as an upper bound", async () => {
    const id = "kie:seedream/5-5-layer-decomposition";
    const model = resolveModel(id);
    expect(model.slots).toEqual([expect.objectContaining({ role: "image", field: "image_url", min: 1, max: 1 })]);
    expect(model.promptRequired).toBe(false);
    expect(optionsOf(id)).toMatchObject({ max_images: { defaultValue: 30 }, size: { defaultValue: "2K" }, text_recognition: { defaultValue: false } });
    expect(build(id, { refUrls: { image: [IMAGE] }, options: { max_images: 4 } }).input)
      .toEqual({ image_url: IMAGE, size: "2K", output_format: "png", max_images: 4, text_recognition: false, nsfw_checker: false });
    expect(refusal(id, {})).toMatch(/at least 1 image ref/u);
    const capped = await estimate(id, { refUrls: { image: [IMAGE] }, options: { max_images: 4 } });
    expect(capped.usd).toBeCloseTo(4 * 0.0315 + 0.0072, 9);
    expect(capped.warnings.join(" ")).toContain("an upper bound");
  });

  it("sizes MiniMax H3 Image by tier and ratio only and names edit sources as pictures", async () => {
    for (const id of ["kie:minimax-h3/text-to-image", "kie:minimax-h3/image-edit"]) {
      const options = optionsOf(id);
      expect(options.width).toBeUndefined();
      expect(options.height).toBeUndefined();
      expect(options).toMatchObject({ resolution: { defaultValue: "2K" }, aspect_ratio: { defaultValue: "9:16" }, expand_prompt: { defaultValue: true } });
    }
    expect(refusal("kie:minimax-h3/text-to-image", { prompt: "a fox", options: { width: 1024, height: 1024 } })).toMatch(/^options\.width: not an option/u);
    const edit = "kie:minimax-h3/image-edit";
    expect(build(edit, { prompt: "swap the hats", refUrls: { image: [IMAGE, IMAGE_2] } }).input).toMatchObject({ image_urls: [IMAGE, IMAGE_2], resolution: "2K" });
    expect(refusal(edit, { prompt: "x", refUrls: { image: Array.from({ length: 17 }, () => IMAGE) } })).toMatch(/at most 16 image refs/u);
    expect(rewrite(edit, "put the hat from @image2 on @image1", { image: [IMAGE_ID, IMAGE_ID_2] })).toBe("put the hat from <Picture 2> on <Picture 1>");
    expect((await estimate("kie:minimax-h3/text-to-image", { prompt: "a fox" })).usd).toBeCloseTo(0.009, 9);
    expect((await estimate("kie:minimax-h3/text-to-image", { prompt: "a fox", options: { resolution: "4K" } })).usd).toBeCloseTo(0.0275, 9);
    expect(await estimate(edit, { prompt: "swap the hats", refUrls: { image: [IMAGE, IMAGE_2] }, options: { resolution: "1K" } }))
      .toEqual({ usd: expect.closeTo(0.009 + 2 * 0.0025, 9), warnings: [] });
  });

  it("upscales one image by a factor and prices the output tier from the source size", async () => {
    const id = "kie:kie/image-upscale";
    const model = resolveModel(id);
    expect(model.promptField).toBeNull();
    expect(optionsOf(id).upscale_factor).toMatchObject({ enumValues: ["1", "2", "4", "8"], defaultValue: "2" });
    expect(build(id, { refUrls: { image: [IMAGE] } }).input).toEqual({ image_url: IMAGE, upscale_factor: "2" });
    expect(refusal(id, { refUrls: { image: [IMAGE] }, options: { upscale_factor: "3" } })).toMatch(/^Upscale factor:/u);
    expect(refusal(id, {})).toMatch(/at least 1 image ref/u);
    const unsized = await estimate(id, { refUrls: { image: [IMAGE] } });
    expect(unsized.usd).toBeCloseTo(0.06, 9);
    expect(unsized.warnings.join(" ")).toContain("costHints.inputWidth and costHints.inputHeight");
    const sized = { inputWidth: 1024, inputHeight: 1536 };
    expect(await estimate(id, { refUrls: { image: [IMAGE] }, options: { upscale_factor: "1" } }, sized)).toEqual({ usd: expect.closeTo(0.0075, 9), warnings: [] });
    expect(await estimate(id, { refUrls: { image: [IMAGE] } }, sized)).toEqual({ usd: expect.closeTo(0.02, 9), warnings: [] });
    expect(await estimate(id, { refUrls: { image: [IMAGE] }, options: { upscale_factor: "4" } }, sized)).toEqual({ usd: expect.closeTo(0.06, 9), warnings: [] });
  });

  it("upscales one video into Kie's output box and prices the source seconds", async () => {
    const id = "kie:video/upscale";
    expect(resolveModel(id).promptField).toBeNull();
    expect(optionsOf(id).resolution).toMatchObject({ enumValues: ["1080P", "2K", "4K"], defaultValue: "4K" });
    expect(build(id, { refUrls: { video: [VIDEO] }, options: { resolution: "2K" } }).input).toEqual({ video_url: VIDEO, resolution: "2K" });
    expect(refusal(id, { refUrls: { video: [VIDEO] }, options: { resolution: "1080p" } })).toMatch(/^Resolution:/u);
    expect(refusal(id, {})).toMatch(/at least 1 video ref/u);
    for (const [resolution, rate] of [["1080P", 0.0075], ["2K", 0.015], ["4K", 0.03]] as const) {
      expect(await estimate(id, { refUrls: { video: [VIDEO] }, options: { resolution } }, { inputDurationSeconds: 10 }))
        .toEqual({ usd: expect.closeTo(10 * rate, 9), warnings: [] });
    }
  });

  it("starts Kling 4.0 Flash from text or a first frame only, at 720p for 3-20 s", async () => {
    const id = "kie:kling-4.0/flash-keyframe-to-video";
    const model = resolveModel(id);
    expect(model.slots.map((slot) => slot.role)).toEqual(["first_frame"]);
    expect(optionsOf(id)).toMatchObject({ duration: { defaultValue: 12 }, resolution: { enumValues: ["720p"] }, aspect_ratio: { enumValues: ["16:9", "9:16", "1:1", "21:9"] } });
    expect(build(id, { prompt: "a fox runs" }).input).toEqual({ prompt: "a fox runs", duration: 12, resolution: "720p", aspect_ratio: "9:16" });
    expect(build(id, { prompt: "@firstframe runs", refUrls: { first_frame: [IMAGE] }, options: { duration: 3 } }).input)
      .toMatchObject({ first_frame_url: IMAGE, duration: 3 });
    expect(refusal(id, { prompt: "x", refUrls: { last_frame: [LAST] } })).toMatch(/does not accept last_frame refs/u);
    expect(refusal(id, { prompt: "x", options: { duration: 21 } })).toMatch(/^Duration:/u);
    expect(rewrite(id, "@firstframe wakes up", { first_frame: [FRAME_ID] })).toBe("@first_frame wakes up");
    expect(await estimate(id, { prompt: "a fox", options: { duration: 5 } })).toEqual({ usd: expect.closeTo(5 * 0.085, 9), warnings: [] });
  });

  it("references Kling 4.0 Flash images and up to 20 s of video, named the Kling 4.0 way", async () => {
    const id = "kie:kling-4.0/flash-reference-to-video";
    const model = resolveModel(id);
    expect(model.entry.rules).toEqual({ refDurationMs: { video: { minimum: 0, maximum: 20_000, maximumTotal: 20_000 } } });
    expect(Object.keys(optionsOf(id))).not.toContain("voices");
    expect(build(id, { prompt: "x", refUrls: { image: [IMAGE, IMAGE_2], video: [VIDEO] } }).input)
      .toMatchObject({ image_urls: [IMAGE, IMAGE_2], video_urls: [VIDEO], resolution: "720p", keep_original_sound: false, elements: [] });
    expect(refusal(id, { prompt: "x", refUrls: { image: Array.from({ length: 11 }, () => IMAGE) } })).toMatch(/at most 10 image refs/u);
    expect(refusal(id, { prompt: "x", refUrls: { video: Array.from({ length: 6 }, () => VIDEO) } })).toMatch(/at most 5 video refs/u);
    expect(rewrite(id, "@image2 hands @image1 to the dancer in @video1", { image: [IMAGE_ID, IMAGE_ID_2], video: [VIDEO_ID] }))
      .toBe("@image_2 hands @image_1 to the dancer in @video_1");
    expect(await estimate(id, { prompt: "x", refUrls: { image: [IMAGE] } })).toEqual({ usd: expect.closeTo(12 * 0.085, 9), warnings: [] });
    const withVideo = { prompt: "x", refUrls: { video: [VIDEO] }, options: { duration: 5 } };
    expect(await estimate(id, withVideo, { inputDurationSeconds: 15 })).toEqual({ usd: expect.closeTo((5 + 15) * 0.0565, 9), warnings: [] });
    expect((await estimate(id, withVideo)).warnings.join(" ")).toContain("costHints.inputDurationSeconds");
  });

  it("serves Gemini Omni 1.2 text, frames, reference images and edits from one Kie model", async () => {
    const model = resolveModel(GEMINI);
    expect(model.modes.map((mode) => mode.id)).toEqual(["t2v", "i2v", "r2v", "v2v"]);
    expect(optionsOf(GEMINI)).toMatchObject({ duration: { defaultValue: 12 }, resolution: { defaultValue: "4k" }, aspect_ratio: { defaultValue: "9:16" } });
    expect(build(GEMINI, { prompt: "a fox" }).input).toEqual({ prompt: "a fox", duration: 12, aspect_ratio: "9:16", resolution: "4k" });
    expect(build(GEMINI, { prompt: "a fox", refUrls: { image: [IMAGE, IMAGE_2] } }).input)
      .toEqual({ prompt: "a fox", duration: 12, aspect_ratio: "9:16", resolution: "4k", image_urls: [IMAGE, IMAGE_2] });
    expect(refusal(GEMINI, { prompt: "x", refUrls: { image: Array.from({ length: 7 }, () => IMAGE) } })).toMatch(/at most 6 image refs/u);
    expect(await estimate(GEMINI, { prompt: "a fox" })).toEqual({ usd: expect.closeTo(12 * 0.11, 9), warnings: [] });
    expect(await estimate(GEMINI, { prompt: "a fox", options: { resolution: "720p", duration: 5 } })).toEqual({ usd: expect.closeTo(5 * 0.045, 9), warnings: [] });
  });

  it("keeps Gemini Omni 1.2 frames within Kie's 10 s cap when a last frame is set", () => {
    const frames = { first_frame: [IMAGE], last_frame: [LAST] };
    expect(build(GEMINI, { prompt: "the cat turns", refUrls: frames }).input)
      .toEqual({ prompt: "the cat turns", duration: 10, aspect_ratio: "9:16", resolution: "4k", first_frame_url: IMAGE, last_frame_url: LAST });
    expect(build(GEMINI, { prompt: "the cat turns", refUrls: { first_frame: [IMAGE] }, options: { duration: 15 } }).input).toMatchObject({ duration: 15 });
    expect(refusal(GEMINI, { prompt: "x", refUrls: frames, options: { duration: 11 } })).toBe("Duration: duration must be 3-10 with first_frame_url and last_frame_url");
    expect(refusal(GEMINI, { prompt: "x", refUrls: { last_frame: [LAST] }, mode: "i2v" })).toMatch(/mode i2v needs one of: first_frame/u);
    expect(refusal(GEMINI, { prompt: "x", refUrls: { first_frame: [IMAGE], image: [IMAGE_2] }, mode: "i2v" })).toMatch(/mode i2v does not accept image refs/u);
    expect(rewrite(GEMINI, "@firstframe wakes up and walks to @lastframe", { first_frame: [FRAME_ID], last_frame: [IMAGE_ID] }))
      .toBe("the first frame wakes up and walks to the last frame");
  });

  it("edits one source video with Gemini Omni 1.2 without a duration and prices the source length", async () => {
    const edit = { prompt: "make it snow on @video1", refUrls: { video: [VIDEO], image: [IMAGE] }, options: { duration: 12, resolution: "720p" } };
    for (const call of [edit, { ...edit, mode: "v2v" }]) {
      const input = build(GEMINI, call).input;
      expect(input).toEqual({ prompt: "make it snow on @video1", aspect_ratio: "auto", resolution: "720p", video_list: [VIDEO], image_urls: [IMAGE] });
      expect(input).not.toHaveProperty("duration");
    }
    expect(refusal(GEMINI, { prompt: "x", refUrls: { video: [VIDEO], image: Array.from({ length: 6 }, () => IMAGE) } }))
      .toBe("Image urls: google/gemini-omni-flash-1-2 quota exceeded: image_urls + 2 for a video_list entry must be <= 7");
    expect(refusal(GEMINI, { prompt: "x", refUrls: { video: [VIDEO, VIDEO] } })).toMatch(/at most 1 video ref/u);
    expect(await estimate(GEMINI, edit, { inputDurationSeconds: 8 })).toEqual({ usd: expect.closeTo(8 * 0.045, 9), warnings: [] });
    expect(rewrite(GEMINI, "dress @video1 like @image2 and @image1", { image: [IMAGE_ID, IMAGE_ID_2], video: [VIDEO_ID] }))
      .toBe("dress <VIDEO_REF_0> like <IMAGE_REF_1> and <IMAGE_REF_0>");
  });

  it("maps the Kie frontier rows of 0.28.0 to catalog entries and gives Gemini Omni 1.1 on Kie its reason", () => {
    const boards = (id: string) => modelFrontierRankings(id).map((ranking) => ranking.type);
    expect(boards("kie:gpt-image-2-6/sunburst-text-to-image")).toEqual(["t2i"]);
    expect(boards("kie:gpt-image-2-6/flare-text-to-image")).toEqual(["t2i"]);
    expect(boards(SUNBURST_EDIT)).toEqual(["i2i"]);
    expect(boards("kie:gpt-image-2-6/flare-image-to-image")).toEqual(["i2i"]);
    expect(boards("kie:seedream/5-5-text-to-image")).toEqual(["t2i"]);
    expect(boards("kie:seedream/5-5-image-to-image")).toEqual(["i2i"]);
    expect(boards(GEMINI)).toEqual(["t2v", "v2v", "r2v"]);
    for (const id of ["kie:wan/3-0-video", "kie:wan/3-0-video-prime", "kie:bytedance/seedance-2-5"]) expect(boards(id), id).toContain("v2v");
    expect(FRONTIER_CATALOG_GAPS["kie:google/gemini-omni-flash-1-1"]).toContain("kie:google/gemini-omni-flash-1-2");
  });
});
