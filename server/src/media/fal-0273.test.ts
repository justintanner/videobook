import { describe, expect, it } from "vitest";
import { FAL_ENDPOINT_REQUEST_SCHEMAS } from "@apicity/fal/zod";
import { resolveModel } from "./descriptor.js";
import { buildWireRequest, type WireRequestInput } from "./request.js";
import { estimateGeneration } from "./cost.js";
import { applyPromptDialect } from "./prompt-dialects.js";
import type { MediaRefs, Operation } from "./types.js";

const IMAGE = "https://example.com/image.png";
const LAST = "https://example.com/last.png";
const MASK = "https://example.com/mask.png";
const MARKUP = "https://example.com/markup.png";
const VIDEO = "https://example.com/video.mp4";
const AUDIO = "https://example.com/audio.mp3";
const IMAGE_ID = "01890f1c-0000-7000-8000-0000000000aa";
const IMAGE_ID_2 = "01890f1c-0000-7000-8000-0000000000bb";
const VIDEO_ID = "01890f1c-0000-7000-8000-0000000000cc";
const AUDIO_ID = "01890f1c-0000-7000-8000-0000000000dd";

const cases: [string, Operation, MediaRefs][] = [
  ["openai/gpt-image-2.6/sunburst/text-to-image", "text_to_image", {}],
  ["openai/gpt-image-2.6/sunburst/edit", "edit_image", { image: [IMAGE] }],
  ["openai/gpt-image-2.6/flare/text-to-image", "text_to_image", {}],
  ["openai/gpt-image-2.6/flare/edit", "edit_image", { image: [IMAGE] }],
  ["google/gemini-omni-flash/v1.2/text-to-video", "text_to_video", {}],
  ["google/gemini-omni-flash/v1.2/image-to-video", "image_to_video", { first_frame: [IMAGE] }],
  ["google/gemini-omni-flash/v1.2/reference-to-video", "reference_to_video", {}],
  ["google/gemini-omni-flash/v1.2/edit", "edit_video", { video: [VIDEO] }],
  ["google/gemini-omni-flash/v1.2/extend", "extend_video", { video: [VIDEO] }],
  ["google/gemini-omni-flash/v1.2/upscale", "upscale_video", { video: [VIDEO] }],
  ["bytedance/seedance-2.0/mini/text-to-video", "text_to_video", {}],
  ["bytedance/seedance-2.0/mini/image-to-video", "image_to_video", { first_frame: [IMAGE] }],
  ["bytedance/seedance-2.0/mini/reference-to-video", "reference_to_video", { image: [IMAGE] }],
];

function build(id: string, call: WireRequestInput): Record<string, unknown> {
  const built = buildWireRequest(resolveModel(id), call);
  if (!built.ok) throw new Error(built.error);
  return built.request;
}

function refusal(id: string, call: WireRequestInput): string {
  const built = buildWireRequest(resolveModel(id), call);
  return built.ok ? "" : built.error;
}

function rewrite(id: string, prompt: string, refs: MediaRefs): string {
  return applyPromptDialect(resolveModel(id).entry.dialect, prompt, refs);
}

async function estimate(id: string, call: WireRequestInput): Promise<{ usd: number; warnings: string[] }> {
  const result = await estimateGeneration(resolveModel(id), call);
  if (!result.ok) throw new Error(result.error);
  return { usd: result.estimate.usd, warnings: result.estimate.warnings };
}

describe("fal 0.27.3 catalog", () => {
  it.each(cases)("%s builds a request apicity's schema accepts from a prompt and its required refs", (apiId, operation, refUrls) => {
    const model = resolveModel(`fal:${apiId}`);
    expect(model.entry.operations).toEqual([operation]);
    expect(model.entry.hidden).toBeUndefined();
    const request = build(model.id, { prompt: model.promptField ? "a red fox in snow" : undefined, refUrls });
    const schema = FAL_ENDPOINT_REQUEST_SCHEMAS[apiId as keyof typeof FAL_ENDPOINT_REQUEST_SCHEMAS];
    expect(schema.safeParse(request).success).toBe(true);
  });

  it("offers GPT Image 2.6 only the raster formats Videobook stores", () => {
    for (const id of ["fal:openai/gpt-image-2.6/sunburst/text-to-image", "fal:openai/gpt-image-2.6/flare/edit"]) {
      const model = resolveModel(id);
      const options = Object.fromEntries(model.options.map((option) => [option.name, option]));
      expect(options.output_format).toMatchObject({ enumValues: ["jpeg", "png", "webp"], defaultValue: "png" });
      expect(options.reasoning_effort).toMatchObject({ enumValues: ["low", "medium", "high"], defaultValue: "high" });
      expect(options.quality).toMatchObject({ defaultValue: "high" });
      for (const name of ["frame_count", "frame_duration_ms", "svg_model"]) expect(options[name], `${id} ${name}`).toBeUndefined();
      const refs = model.entry.operations.includes("edit_image") ? { image: [IMAGE] } : {};
      expect(refusal(id, { prompt: "a fox", refUrls: refs, options: { output_format: "gif" } })).toMatch(/^Output format:/u);
    }
    expect(refusal("fal:openai/gpt-image-2.6/sunburst/text-to-image", { prompt: "a fox", options: { output_format: "svg" } })).toMatch(/^Output format:/u);
    const request = build("fal:openai/gpt-image-2.6/sunburst/text-to-image", { prompt: "a fox" });
    expect(request).toMatchObject({ prompt: "a fox", image_size: "portrait_16_9", quality: "high", reasoning_effort: "high", output_format: "png", num_images: 1 });
    for (const name of ["frame_count", "frame_duration_ms", "svg_model"]) expect(request).not.toHaveProperty(name);
  });

  it("sends GPT Image 2.6 edit sources, a mask or a markup image, never both", () => {
    const id = "fal:openai/gpt-image-2.6/sunburst/edit";
    const model = resolveModel(id);
    expect(model.slots).toEqual([expect.objectContaining({ role: "image", min: 1, max: 16 })]);
    expect(model.fieldSlots.map(({ field, label, kind }) => ({ field, label, kind }))).toEqual([
      { field: "mask_url", label: "Mask", kind: "image" },
      { field: "markup_image_url", label: "Markup", kind: "image" },
    ]);
    const images = { image: [IMAGE, LAST] };
    expect(build(id, { prompt: "circle the hat", refUrls: images, fieldUrls: { markup_image_url: [MARKUP] } }))
      .toMatchObject({ image_urls: [IMAGE, LAST], markup_image_url: MARKUP, image_size: "auto" });
    expect(build(id, { prompt: "repaint the sky", refUrls: images, fieldUrls: { mask_url: [MASK] } }))
      .toMatchObject({ image_urls: [IMAGE, LAST], mask_url: MASK });
    expect(refusal(id, { prompt: "x", refUrls: images, fieldUrls: { mask_url: [MASK], markup_image_url: [MARKUP] } }))
      .toBe("Markup image url: can't be combined with a mask");
    expect(refusal(id, { prompt: "x", refUrls: { image: Array.from({ length: 17 }, () => IMAGE) } })).toMatch(/at most 16 image refs/u);
    expect(rewrite(id, "put the hat from @image2 on @image1", { image: [IMAGE_ID, IMAGE_ID_2] }))
      .toBe("put the hat from reference image 2 on reference image 1");
  });

  it("keeps Gemini Omni 1.2 frames within the 10 s end-frame cap and its other clips at 15 s", () => {
    const frames = "fal:google/gemini-omni-flash/v1.2/image-to-video";
    expect(build(frames, { prompt: "the cat turns", refUrls: { first_frame: [IMAGE], last_frame: [LAST] } }))
      .toMatchObject({ image_url: IMAGE, end_image_url: LAST, duration: 10, aspect_ratio: "9:16", resolution: "4k" });
    expect(build(frames, { prompt: "the cat turns", refUrls: { first_frame: [IMAGE] }, options: { duration: 15 } })).toMatchObject({ duration: 15 });
    expect(refusal(frames, { prompt: "x", refUrls: { first_frame: [IMAGE], last_frame: [LAST] }, options: { duration: 11 } }))
      .toBe("Duration: at most 10 seconds with a last frame");
    expect(refusal(frames, { prompt: "x", refUrls: { last_frame: [LAST] } })).toMatch(/at least 1 first_frame ref/u);
    expect(rewrite(frames, "@firstframe wakes up and walks to @lastframe", { first_frame: [IMAGE_ID], last_frame: [IMAGE_ID_2] }))
      .toBe("wakes up and walks to");
    expect(build("fal:google/gemini-omni-flash/v1.2/text-to-video", { prompt: "a fox" })).toMatchObject({ duration: 12, aspect_ratio: "9:16" });
    expect(build("fal:google/gemini-omni-flash/v1.2/text-to-video", { prompt: "a fox", options: { duration: 15 } })).toMatchObject({ duration: 15 });
    expect(refusal("fal:google/gemini-omni-flash/v1.2/text-to-video", { prompt: "a fox", options: { duration: 16 } })).toMatch(/^Duration:/u);
  });

  it("sends Gemini Omni 1.2 references in list order and names them with its markers", () => {
    const id = "fal:google/gemini-omni-flash/v1.2/reference-to-video";
    const videos = [VIDEO, "https://example.com/video2.mp4"];
    expect(build(id, { prompt: "a dance", refUrls: { image: [IMAGE, LAST], video: videos }, options: { duration: 15 } }))
      .toMatchObject({ image_urls: [IMAGE, LAST], reference_video_urls: videos, duration: 15 });
    expect(refusal(id, { prompt: "x", refUrls: { video: [VIDEO, VIDEO, VIDEO, VIDEO] } })).toMatch(/at most 3 video refs/u);
    expect(rewrite(id, "dress @video1 like @image2 and @image1", { image: [IMAGE_ID, IMAGE_ID_2], video: [VIDEO_ID] }))
      .toBe("dress <VIDEO_REF_0> like <IMAGE_REF_1> and <IMAGE_REF_0>");
  });

  it("edits, extends and upscales one Gemini Omni 1.2 source video", () => {
    expect(build("fal:google/gemini-omni-flash/v1.2/edit", { prompt: "make it snow on @video1", refUrls: { video: [VIDEO] } }))
      .toEqual({ prompt: "make it snow on @video1", video_url: VIDEO, resolution: "4k" });
    expect(rewrite("fal:google/gemini-omni-flash/v1.2/edit", "make it snow on @video1", { video: [VIDEO_ID] })).toBe("make it snow on the source video");
    expect(build("fal:google/gemini-omni-flash/v1.2/extend", { prompt: "keep walking", refUrls: { video: [VIDEO] }, options: { resolution: "720p" } }))
      .toEqual({ prompt: "keep walking", video_url: VIDEO, resolution: "720p", duration: 10 });
    expect(refusal("fal:google/gemini-omni-flash/v1.2/extend", { prompt: "x", refUrls: { video: [VIDEO] }, options: { duration: 11 } })).toMatch(/^Duration:/u);
    const upscale = resolveModel("fal:google/gemini-omni-flash/v1.2/upscale");
    expect(upscale.promptField).toBeNull();
    expect(build(upscale.id, { refUrls: { video: [VIDEO] } })).toEqual({ video_url: VIDEO, resolution: "4k" });
    expect(build(upscale.id, { refUrls: { video: [VIDEO] }, options: { resolution: "1080p" } })).toEqual({ video_url: VIDEO, resolution: "1080p" });
    expect(refusal(upscale.id, { refUrls: { video: [VIDEO] }, options: { resolution: "360p" } })).toMatch(/^Resolution:/u);
    for (const id of ["fal:google/gemini-omni-flash/v1.2/edit", "fal:google/gemini-omni-flash/v1.2/extend", upscale.id]) {
      expect(refusal(id, { prompt: resolveModel(id).promptField ? "x" : undefined })).toMatch(/at least 1 video ref/u);
    }
  });

  it("wires Seedance 2.0 Mini frames and references like 2.0 Fast", () => {
    expect(build("fal:bytedance/seedance-2.0/mini/image-to-video", { prompt: "the cat turns", refUrls: { first_frame: [IMAGE], last_frame: [LAST] } }))
      .toMatchObject({ image_url: IMAGE, end_image_url: LAST, resolution: "720p", duration: "12", aspect_ratio: "9:16", generate_audio: true });
    const id = "fal:bytedance/seedance-2.0/mini/reference-to-video";
    expect(build(id, { prompt: "a walk", refUrls: { image: [IMAGE], video: [VIDEO], audio: [AUDIO] } }))
      .toMatchObject({ image_urls: [IMAGE], video_urls: [VIDEO], audio_urls: [AUDIO] });
    expect(refusal(id, { prompt: "x", refUrls: { audio: [AUDIO] } })).toMatch(/needs one of: image, video/u);
    expect(refusal(id, { prompt: "x", refUrls: { image: Array.from({ length: 9 }, () => IMAGE), video: [VIDEO, VIDEO], audio: [AUDIO, AUDIO] } }))
      .toMatch(/Total files across all modalities must not exceed 12/u);
    expect(refusal("fal:bytedance/seedance-2.0/mini/text-to-video", { prompt: "x", options: { resolution: "1080p" } })).toMatch(/^Resolution:/u);
    expect(rewrite(id, "@image1 dances to @audio1 like @video1", { image: [IMAGE_ID], video: [VIDEO_ID], audio: [AUDIO_ID] }))
      .toBe("@Image1 dances to @Audio1 like @Video1");
  });

  it("prices Seedance 2.0 Mini from the @apicity/cost token formula and leaves video or audio references unpriced", async () => {
    const tokens = (width: number, height: number, seconds: number) => width * height * (24 * seconds + 1) / 1024;
    const rate = 0.007 / 1000;
    const text = await estimate("fal:bytedance/seedance-2.0/mini/text-to-video", { prompt: "x", options: { resolution: "720p", aspect_ratio: "16:9", duration: "5" } });
    expect(text.usd).toBeCloseTo(tokens(1280, 720, 5) * rate, 9);
    expect(text.warnings).toEqual([]);
    const frames = await estimate("fal:bytedance/seedance-2.0/mini/image-to-video", { prompt: "x", refUrls: { first_frame: [IMAGE] }, options: { resolution: "480p", duration: "5" } });
    expect(frames.usd).toBeCloseTo(tokens(496, 864, 5) * rate, 9);
    const id = "fal:bytedance/seedance-2.0/mini/reference-to-video";
    const images = await estimate(id, { prompt: "x", refUrls: { image: [IMAGE] }, options: { resolution: "720p", aspect_ratio: "1:1", duration: "4" } });
    expect(images.usd).toBeCloseTo(tokens(960, 960, 4) * rate, 9);
    expect(images.warnings).toEqual([]);
    for (const refUrls of [{ image: [IMAGE], video: [VIDEO] }, { image: [IMAGE], audio: [AUDIO] }]) {
      const unpriced = await estimate(id, { prompt: "x", refUrls, options: { aspect_ratio: "1:1", duration: "4" } });
      expect(unpriced.usd).toBe(0);
      expect(unpriced.warnings.join(" ")).toContain("only a request whose references are images alone is priced");
    }
  });
});
