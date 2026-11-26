import { describe, expect, it } from "vitest";
import { computeEstimate, type CostHints } from "@apicity/cost";
import * as WaveSpeedSchemas from "@apicity/wavespeed/zod";
import type { ZodType } from "zod";
import { resolveModel } from "./descriptor.js";
import { buildWireRequest, type WireRequestInput } from "./request.js";
import { estimateGeneration } from "./cost.js";
import { modelFrontierRankings } from "./frontier.js";
import { applyPromptDialect } from "./prompt-dialects.js";
import type { Media, MediaRefs, Operation, PromptGuide } from "./types.js";

const IMAGE = "https://example.test/image.png";
const IMAGE_2 = "https://example.test/image2.png";
const LAST = "https://example.test/last.png";
const MASK = "https://example.test/mask.png";
const MARKUP = "https://example.test/markup.png";
const VIDEO = "https://example.test/video.mp4";
const IMAGE_ID = "01890f1c-0000-7000-8000-0000000000aa";
const IMAGE_ID_2 = "01890f1c-0000-7000-8000-0000000000bb";
const VIDEO_ID = "01890f1c-0000-7000-8000-0000000000cc";

const cases: [string, string, Media, Operation, PromptGuide | undefined, string, MediaRefs][] = [
  ["openai/gpt-image-2.6-sunburst/text-to-image", "GPT Image 2.6 Sunburst (WaveSpeed)", "image", "text_to_image", "gpt_image_26", "WaveSpeedOpenaiGptImage2p6SunburstTextToImageRequestSchema", {}],
  ["openai/gpt-image-2.6-sunburst/edit", "GPT Image 2.6 Sunburst Edit (WaveSpeed)", "image", "edit_image", "gpt_image_26", "WaveSpeedOpenaiGptImage2p6SunburstEditRequestSchema", { image: [IMAGE] }],
  ["openai/gpt-image-2.6-flare/text-to-image", "GPT Image 2.6 Flare (WaveSpeed)", "image", "text_to_image", "gpt_image_26", "WaveSpeedOpenaiGptImage2p6FlareTextToImageRequestSchema", {}],
  ["openai/gpt-image-2.6-flare/edit", "GPT Image 2.6 Flare Edit (WaveSpeed)", "image", "edit_image", "gpt_image_26", "WaveSpeedOpenaiGptImage2p6FlareEditRequestSchema", { image: [IMAGE] }],
  ["openai/gpt-image-2.5-sunburst/text-to-image", "GPT Image 2.5 Sunburst (WaveSpeed)", "image", "text_to_image", "gpt_image", "WaveSpeedOpenaiGptImage2p5SunburstTextToImageRequestSchema", {}],
  ["openai/gpt-image-2.5-flare/text-to-image", "GPT Image 2.5 Flare (WaveSpeed)", "image", "text_to_image", "gpt_image", "WaveSpeedOpenaiGptImage2p5FlareTextToImageRequestSchema", {}],
  ["openai/gpt-image-2/text-to-image", "GPT Image 2 (WaveSpeed)", "image", "text_to_image", "gpt_image", "WaveSpeedOpenaiGptImage2TextToImageRequestSchema", {}],
  ["google/nano-banana-2.1/text-to-image", "Nano Banana 2.1 (WaveSpeed)", "image", "text_to_image", "nano_banana", "WaveSpeedGoogleNanoBanana2p1TextToImageRequestSchema", {}],
  ["google/nano-banana-2.1/edit", "Nano Banana 2.1 Edit (WaveSpeed)", "image", "edit_image", "nano_banana", "WaveSpeedGoogleNanoBanana2p1EditRequestSchema", { image: [IMAGE] }],
  ["x-ai/grok-imagine-image-v2.0/text-to-image", "Grok Imagine Image 2.0 (WaveSpeed)", "image", "text_to_image", "grok_image", "WaveSpeedXAiGrokImagineImageV2p0TextToImageRequestSchema", {}],
  ["bytedance/seedream-v5.5/edit", "Seedream 5.5 Edit (WaveSpeed)", "image", "edit_image", undefined, "WaveSpeedBytedanceSeedreamV5p5EditRequestSchema", { image: [IMAGE] }],
  ["google/gemini-omni-1.2-flash/text-to-video", "Gemini Omni 1.2 Flash (WaveSpeed)", "video", "text_to_video", undefined, "WaveSpeedGoogleGeminiOmni1p2FlashTextToVideoRequestSchema", {}],
  ["google/gemini-omni-1.2-flash/reference-to-video", "Gemini Omni 1.2 Flash References (WaveSpeed)", "video", "reference_to_video", undefined, "WaveSpeedGoogleGeminiOmni1p2FlashReferenceToVideoRequestSchema", { image: [IMAGE], video: [VIDEO] }],
  ["google/gemini-omni-1.2-flash/video-edit", "Gemini Omni 1.2 Flash Edit (WaveSpeed)", "video", "edit_video", undefined, "WaveSpeedGoogleGeminiOmni1p2FlashVideoEditRequestSchema", { video: [VIDEO] }],
  ["skywork-ai/skyreels-v4/text-to-video", "SkyReels V4 (WaveSpeed)", "video", "text_to_video", undefined, "WaveSpeedSkyworkAiSkyreelsV4TextToVideoRequestSchema", {}],
  ["pruna-ai/p-video-2-pro/image-to-video", "P-Video 2 Pro Image (WaveSpeed)", "video", "image_to_video", undefined, "WaveSpeedPrunaAiPVideo2ProImageToVideoRequestSchema", { first_frame: [IMAGE] }],
  ["heygen/video-1.0/image-to-video", "HeyGen Video Image (WaveSpeed)", "video", "image_to_video", undefined, "WaveSpeedHeygenVideo1p0ImageToVideoRequestSchema", { first_frame: [IMAGE] }],
];

const SUNBURST_EDIT = "wavespeed:openai/gpt-image-2.6-sunburst/edit";
const GEMINI_EDIT = "wavespeed:google/gemini-omni-1.2-flash/video-edit";
const SKYREELS = "wavespeed:skywork-ai/skyreels-v4/text-to-video";

function build(id: string, call: WireRequestInput): Record<string, unknown> {
  const built = buildWireRequest(resolveModel(id), call);
  if (!built.ok) throw new Error(built.error);
  return built.request;
}

function refusal(id: string, call: WireRequestInput): string {
  const built = buildWireRequest(resolveModel(id), call);
  return built.ok ? "" : built.error;
}

function optionsOf(id: string): Record<string, { defaultValue?: unknown; enumValues: Array<string | number>; minimum?: number; maximum?: number }> {
  return Object.fromEntries(resolveModel(id).options.map((option) => [option.name, option]));
}

async function estimate(id: string, call: WireRequestInput, hints: CostHints = {}): Promise<{ usd: number; warnings: string[] }> {
  const result = await estimateGeneration(resolveModel(id), call, hints);
  if (!result.ok) throw new Error(result.error);
  return { usd: result.estimate.usd, warnings: result.estimate.warnings };
}

describe("WaveSpeed 0.28.1 catalog", () => {
  it.each(cases)("%s builds a request apicity's schema accepts and @apicity/cost prices", async (apiId, title, media, operation, guide, schemaName, refUrls) => {
    const id = `wavespeed:${apiId}`;
    const model = resolveModel(id);
    expect(model).toMatchObject({ title, media, entry: { operations: [operation] } });
    expect(model.entry.guide).toBe(guide);
    expect(model.entry.hidden).toBeUndefined();
    const request = build(id, { prompt: "a red fox in snow", refUrls });
    const schema = (WaveSpeedSchemas as unknown as Record<string, ZodType>)[schemaName]!;
    expect(schema.safeParse(request).success).toBe(true);
    const priced = await estimate(id, { prompt: "a red fox in snow", refUrls }, { inputDurationSeconds: 5 });
    expect(priced.warnings).toEqual([]);
    expect(priced.usd).toBeCloseTo(computeEstimate({ provider: "wavespeed", endpoint: apiId, payload: request, costHints: { inputDurationSeconds: 5 } }).usd, 9);
    expect(priced.usd).toBeGreaterThan(0);
  });

  it("offers WaveSpeed GPT Image 2.6 only the raster formats Videobook stores", () => {
    for (const id of ["wavespeed:openai/gpt-image-2.6-flare/text-to-image", SUNBURST_EDIT]) {
      const options = optionsOf(id);
      expect(options.output_format).toMatchObject({ enumValues: ["jpeg", "png", "webp"], defaultValue: "png" });
      expect(options.quality).toMatchObject({ enumValues: ["low", "medium", "high", "xhigh", "max"], defaultValue: "high" });
      expect(options.resolution).toMatchObject({ enumValues: ["1k", "2k", "4k"], defaultValue: "2k" });
      expect(options.complexity).toMatchObject({ enumValues: ["low", "medium", "high"] });
      for (const name of ["frame_count", "frame_duration_ms"]) expect(options[name], `${id} ${name}`).toBeUndefined();
      const refUrls = id === SUNBURST_EDIT ? { image: [IMAGE] } : {};
      expect(refusal(id, { prompt: "a fox", refUrls, options: { output_format: "gif" } })).toMatch(/^Output format:/u);
    }
    expect(refusal("wavespeed:openai/gpt-image-2.6-flare/text-to-image", { prompt: "a fox", options: { output_format: "svg" } })).toMatch(/^Output format:/u);
  });

  it("sends WaveSpeed GPT Image 2.6 edit sources with a mask or a markup image, never both", () => {
    const model = resolveModel(SUNBURST_EDIT);
    expect(model.slots).toEqual([expect.objectContaining({ role: "image", field: "images", min: 1, max: 16 })]);
    expect(model.fieldSlots.map(({ field, label, kind }) => ({ field, label, kind }))).toEqual([
      { field: "mask_image", label: "Mask", kind: "image" },
      { field: "markup_image", label: "Markup", kind: "image" },
    ]);
    const images = { image: [IMAGE, IMAGE_2] };
    expect(build(SUNBURST_EDIT, { prompt: "circle the hat", refUrls: images, fieldUrls: { markup_image: [MARKUP] } }))
      .toMatchObject({ images: [IMAGE, IMAGE_2], markup_image: MARKUP });
    expect(build(SUNBURST_EDIT, { prompt: "repaint the sky", refUrls: images, fieldUrls: { mask_image: [MASK] } }))
      .toMatchObject({ images: [IMAGE, IMAGE_2], mask_image: MASK });
    expect(refusal(SUNBURST_EDIT, { prompt: "x", refUrls: images, fieldUrls: { mask_image: [MASK], markup_image: [MARKUP] } }))
      .toMatch(/can't be combined with a mask$/u);
    expect(refusal(SUNBURST_EDIT, { prompt: "x" })).toBe(`${SUNBURST_EDIT} requires at least 1 image ref`);
    expect(refusal(SUNBURST_EDIT, { prompt: "x", refUrls: { image: Array.from({ length: 17 }, () => IMAGE) } })).toMatch(/at most 16 image refs/u);
    expect(applyPromptDialect(model.entry.dialect, "put the hat from @image2 on @image1", { image: [IMAGE_ID, IMAGE_ID_2] }))
      .toBe("put the hat from reference image 2 on reference image 1");
  });

  it("prices WaveSpeed GPT Image 2.6 by quality and resolution and each extra source image", async () => {
    const low = await estimate("wavespeed:openai/gpt-image-2.6-sunburst/text-to-image", { prompt: "a fox", options: { quality: "low", resolution: "1k" } });
    const max = await estimate("wavespeed:openai/gpt-image-2.6-sunburst/text-to-image", { prompt: "a fox", options: { quality: "max", resolution: "4k" } });
    expect(max.usd).toBeGreaterThan(low.usd);
    const one = await estimate(SUNBURST_EDIT, { prompt: "a fox", refUrls: { image: [IMAGE] } });
    const two = await estimate(SUNBURST_EDIT, { prompt: "a fox", refUrls: { image: [IMAGE, IMAGE_2] } });
    expect(two.usd).toBeGreaterThan(one.usd);
  });

  it("caps Seedream 5.5 and Nano Banana 2.1 edits at WaveSpeed's source counts and prices each source", async () => {
    const seedream = "wavespeed:bytedance/seedream-v5.5/edit";
    expect(resolveModel(seedream).slots).toEqual([expect.objectContaining({ role: "image", field: "images", min: 1, max: 10 })]);
    expect(refusal(seedream, { prompt: "make it night", refUrls: { image: Array.from({ length: 11 }, () => IMAGE) } })).toMatch(/at most 10 image refs/u);
    expect(optionsOf(seedream).resolution).toMatchObject({ enumValues: ["1k", "1.5k", "2k"], defaultValue: "2k" });
    const one = await estimate(seedream, { prompt: "make it night", refUrls: { image: [IMAGE] } });
    const three = await estimate(seedream, { prompt: "make it night", refUrls: { image: [IMAGE, IMAGE_2, LAST] } });
    expect(three.usd).toBeGreaterThan(one.usd);

    const banana = "wavespeed:google/nano-banana-2.1/edit";
    expect(resolveModel(banana).slots).toEqual([expect.objectContaining({ role: "image", field: "images", min: 1, max: 14 })]);
    const plain = await estimate(banana, { prompt: "paint it blue", refUrls: { image: [IMAGE] } });
    const searched = await estimate(banana, { prompt: "paint it blue", refUrls: { image: [IMAGE] }, options: { enable_web_search: true } });
    expect(searched.usd).toBeGreaterThan(plain.usd);
  });

  it("names Gemini Omni 1.2 references with Gemini's markers and bills its edit by the source video", async () => {
    const references = resolveModel("wavespeed:google/gemini-omni-1.2-flash/reference-to-video");
    expect(references.slots.map((slot) => [slot.role, slot.field, slot.max])).toEqual([["image", "images", 10], ["video", "reference_videos", 3]]);
    expect(build(references.id, { prompt: "a walk", refUrls: { image: [IMAGE], video: [VIDEO] } })).toMatchObject({ images: [IMAGE], reference_videos: [VIDEO] });
    expect(applyPromptDialect(references.entry.dialect, "@image1 moves like @video1", { image: [IMAGE_ID], video: [VIDEO_ID] }))
      .toBe("<IMAGE_REF_0> moves like <VIDEO_REF_0>");
    expect(optionsOf(references.id).duration).toMatchObject({ minimum: 3, maximum: 15 });

    const edit = resolveModel(GEMINI_EDIT);
    expect(edit.slots.map((slot) => [slot.role, slot.field, slot.min, slot.max])).toEqual([["video", "video", 1, 1]]);
    expect(Object.keys(optionsOf(GEMINI_EDIT))).toEqual(["resolution"]);
    expect(build(GEMINI_EDIT, { prompt: "make it night", refUrls: { video: [VIDEO] }, options: { resolution: "720p" } }))
      .toEqual({ video: VIDEO, prompt: "make it night", resolution: "720p" });
    const sixSeconds = await estimate(GEMINI_EDIT, { prompt: "make it night", refUrls: { video: [VIDEO] }, options: { resolution: "720p" } }, { inputDurationSeconds: 6 });
    expect(sixSeconds.warnings).toEqual([]);
    expect(sixSeconds.usd).toBeCloseTo(computeEstimate({
      provider: "wavespeed", endpoint: "google/gemini-omni-1.2-flash/video-edit",
      payload: { video: VIDEO, prompt: "make it night", resolution: "720p" }, costHints: { inputDurationSeconds: 6 },
    }).usd, 9);
    const unknownLength = await estimate(GEMINI_EDIT, { prompt: "make it night", refUrls: { video: [VIDEO] } });
    expect(unknownLength).toMatchObject({ usd: 0, warnings: [expect.stringContaining("inputDurationSeconds")] });
  });

  it("refuses SkyReels V4 sound in fast mode and offers its 3-15 s clips", async () => {
    expect(optionsOf(SKYREELS)).toMatchObject({
      duration: { minimum: 3, maximum: 15, defaultValue: 12 },
      mode: { enumValues: ["std", "fast"] },
      resolution: { enumValues: ["480p", "720p", "1080p"], defaultValue: "1080p" },
    });
    expect(refusal(SKYREELS, { prompt: "a wave", options: { mode: "fast", sound: true } })).toMatch(/fast mode can't generate sound$/u);
    expect(build(SKYREELS, { prompt: "a wave", options: { mode: "fast", duration: 5, resolution: "720p" } }))
      .toEqual({ prompt: "a wave", mode: "fast", duration: 5, aspect_ratio: "9:16", resolution: "720p" });
    const fast = await estimate(SKYREELS, { prompt: "a wave", options: { mode: "fast", duration: 5, resolution: "720p" } });
    const standard = await estimate(SKYREELS, { prompt: "a wave", options: { duration: 5, resolution: "720p" } });
    expect(fast.usd).toBeLessThan(standard.usd);
  });

  it("maps P-Video 2 Pro frames and HeyGen's first frame onto WaveSpeed's image fields", () => {
    const pvideo = resolveModel("wavespeed:pruna-ai/p-video-2-pro/image-to-video");
    expect(pvideo.modes).toEqual([{ id: "i2v", label: "Frames", roles: ["first_frame", "last_frame"], requireAny: ["first_frame"] }]);
    expect(build(pvideo.id, { prompt: "the cat blinks", refUrls: { first_frame: [IMAGE], last_frame: [LAST] }, options: { duration: 5, mode: "cost" } }))
      .toMatchObject({ image: IMAGE, last_image: LAST, duration: 5, mode: "cost" });
    expect(optionsOf(pvideo.id).duration).toMatchObject({ minimum: 5, maximum: 15 });
    const heygen = resolveModel("wavespeed:heygen/video-1.0/image-to-video");
    expect(heygen.slots.map((slot) => [slot.role, slot.field, slot.min])).toEqual([["first_frame", "image", 1]]);
    expect(applyPromptDialect(heygen.entry.dialect, "@firstframe the cat blinks", { first_frame: [IMAGE_ID] })).toBe("the cat blinks");
  });

  it("ranks the new entries on their frontier boards", () => {
    const boards = (apiId: string) => modelFrontierRankings(`wavespeed:${apiId}`).map((ranking) => [ranking.type, ranking.rank]);
    expect(boards("openai/gpt-image-2.6-sunburst/text-to-image")).toEqual([["t2i", 1]]);
    expect(boards("openai/gpt-image-2.6-sunburst/edit")).toEqual([["i2i", 2]]);
    expect(boards("openai/gpt-image-2.6-flare/edit")).toEqual([["i2i", 3]]);
    expect(boards("bytedance/seedream-v5.5/edit")).toEqual([["i2i", 8]]);
    expect(boards("google/gemini-omni-1.2-flash/text-to-video")).toEqual([["t2v", 6]]);
    expect(boards("skywork-ai/skyreels-v4/text-to-video")).toEqual([]);
    expect(boards("pruna-ai/p-video-2-pro/image-to-video")).toEqual([]);
    expect(boards("google/gemini-omni-1.2-flash/video-edit")).toEqual([["v2v", 2]]);
    expect(modelFrontierRankings("machgen:GPT-Image-2.6-Sunburst").map((ranking) => [ranking.type, ranking.rank])).toEqual([["t2i", 1], ["i2i", 2]]);
    expect(modelFrontierRankings("machgen:GPT-Image-2.6-Flare").map((ranking) => [ranking.type, ranking.rank])).toEqual([["t2i", 3], ["i2i", 3]]);
  });
});
