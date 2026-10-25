import { describe, expect, it } from "vitest";
import type { CostHints } from "@apicity/cost";
import {
  GrokVideo15PreviewRequestSchema,
  Kling40KeyframeToVideoRequestSchema,
  Kling40ReferenceToVideoRequestSchema,
  Omnihuman20RequestSchema,
  PixverseV6MaxImageToVideoRequestSchema,
  PixverseV6MaxTextToVideoRequestSchema,
} from "@apicity/kie/zod";
import type { ZodType } from "zod";
import { resolveModel } from "./descriptor.js";
import { buildWireRequest, type WireRequestInput } from "./request.js";
import { estimateGeneration } from "./cost.js";
import { modelFrontierRankings } from "./frontier.js";
import { applyPromptDialect } from "./prompt-dialects.js";
import type { MediaRefs, Operation } from "./types.js";

const image = "https://example.com/image.png";
const first = "https://example.com/first.png";
const last = "https://example.com/last.png";
const video = "https://example.com/video.mp4";
const audio = "https://example.com/voice.mp3";
const A = "0198c2a0-0000-7000-8000-00000000000a";
const B = "0198c2a0-0000-7000-8000-00000000000b";
const C = "0198c2a0-0000-7000-8000-00000000000c";
const D = "0198c2a0-0000-7000-8000-00000000000d";

const cases: [string, readonly Operation[], MediaRefs, ZodType][] = [
  ["kling-4.0/reference-to-video", ["reference_to_video"], { image: [image], video: [video] }, Kling40ReferenceToVideoRequestSchema],
  ["kling-4.0/keyframe-to-video", ["image_to_video"], { first_frame: [first], image: [image], last_frame: [last] }, Kling40KeyframeToVideoRequestSchema],
  ["pixverse-v6-max/text-to-video", ["text_to_video"], {}, PixverseV6MaxTextToVideoRequestSchema],
  ["pixverse-v6-max/image-to-video", ["image_to_video"], { image: [image] }, PixverseV6MaxImageToVideoRequestSchema],
  ["omnihuman-2-0", ["image_to_video", "lip_sync"], { image: [image], audio: [audio] }, Omnihuman20RequestSchema],
  ["grok-imagine-video-1-5-preview", ["image_to_video"], { image: [image] }, GrokVideo15PreviewRequestSchema],
];

describe("kie 0.18.1 video catalog", () => {
  it.each(cases)("%s builds its apicity request from a prompt and its refs", (apiId, operations, refUrls, schema) => {
    const model = resolveModel(`kie:${apiId}`);
    expect(model.entry.operations).toEqual(operations);
    const built = buildWireRequest(model, { prompt: "A presenter waves", refUrls });
    expect(built).toMatchObject({ ok: true, request: { model: apiId } });
    if (built.ok) expect(schema.safeParse(built.request).success).toBe(true);
  });

  it("runs Kling 4.0 references without materials and names materials the way Kling 4.0 mentions them", () => {
    const model = resolveModel("kie:kling-4.0/reference-to-video");
    expect(buildWireRequest(model, { prompt: "A fox runs" })).toMatchObject({
      ok: true,
      request: { input: { prompt: "A fox runs", duration: 12, resolution: "1080p", aspect_ratio: "9:16", image_urls: [], video_urls: [] } },
    });
    expect(buildWireRequest(model, { prompt: "x", refUrls: { image: [image, first], video: [video] } }))
      .toMatchObject({ ok: true, request: { input: { image_urls: [image, first], video_urls: [video] } } });
    expect(buildWireRequest(model, { prompt: "x", refUrls: { image: Array<string>(11).fill(image) } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("at most 10 image refs") });
    expect(buildWireRequest(model, { prompt: "x", refUrls: { video: Array<string>(6).fill(video) } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("at most 5 video refs") });
    expect(applyPromptDialect(model.entry.dialect, "@image2 hands @image1 to the dancer in @video1", { image: [A, B], video: [C] }))
      .toBe("@image_2 hands @image_1 to the dancer in @video_1");
  });

  it("sends Kling 4.0 first, middle and last frames in order and caps them by duration", () => {
    const model = resolveModel("kie:kling-4.0/keyframe-to-video");
    expect(model.slots.map((slot) => [slot.role, slot.field, slot.max])).toEqual([
      ["first_frame", "first_frame_url", 1],
      ["last_frame", "last_frame_url", 1],
      ["image", "keyframe_urls", 8],
    ]);
    expect(buildWireRequest(model, { prompt: "x", refUrls: { first_frame: [first], image: [image, video], last_frame: [last] } }))
      .toMatchObject({ ok: true, request: { input: { first_frame_url: first, keyframe_urls: [image, video], last_frame_url: last } } });
    expect(buildWireRequest(model, { prompt: "A fox runs" }))
      .toMatchObject({ ok: true, request: { input: { aspect_ratio: "9:16", keyframe_urls: [] } } });
    expect(buildWireRequest(model, { prompt: "x", refUrls: { first_frame: [first], image: [image, image, image], last_frame: [last] }, options: { duration: 3 } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("duration 3s allows at most 4 frames") });
    expect(applyPromptDialect(model.entry.dialect, "@firstframe turns into @image1, then @image2 and @lastframe", { first_frame: [A], image: [B, C], last_frame: [D] }))
      .toBe("@first_frame turns into @keyframe_1, then @keyframe_2 and @last_frame");
  });

  it("defaults PixVerse V6 Max to 1080p and lets image-to-video follow the image's aspect ratio", () => {
    expect(buildWireRequest(resolveModel("kie:pixverse-v6-max/text-to-video"), { prompt: "A fox runs" })).toMatchObject({
      ok: true,
      request: { input: { quality: "1080p", duration: 12, aspect_ratio: "9:16", generate_audio_switch: false } },
    });
    const model = resolveModel("kie:pixverse-v6-max/image-to-video");
    expect(model.options.map((option) => option.name)).toEqual(["quality", "duration", "generate_audio_switch", "seed"]);
    const built = buildWireRequest(model, { prompt: "x", refUrls: { image: [image] } });
    expect(built).toMatchObject({ ok: true, request: { input: { image_urls: [image], quality: "1080p", duration: 12 } } });
    if (built.ok) expect(built.request.input).not.toHaveProperty("aspect_ratio");
    expect(buildWireRequest(model, { prompt: "x", refUrls: { image: [image] }, options: { aspect_ratio: "16:9" } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("options.aspect_ratio") });
    expect(buildWireRequest(model, { prompt: "x", refUrls: { image: [image, first] } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("at most 1 image ref") });
    expect(applyPromptDialect(model.entry.dialect, "@image1 starts running", { image: [A] })).toBe("starts running");
  });

  it("drives OmniHuman 2.0 with one image, the driving audio and an optional short prompt, without KIE's watermark by default", () => {
    const model = resolveModel("kie:omnihuman-2-0");
    expect(model.entry.operations).toEqual(resolveModel("kie:omnihuman-1-5").entry.operations);
    expect(buildWireRequest(model, { refUrls: { image: [image], audio: [audio] } }))
      .toMatchObject({ ok: true, request: { input: { image_urls: [image], audio_url: audio, enable_watermark: false } } });
    expect(buildWireRequest(model, { refUrls: { image: [image], audio: [audio] }, options: { enable_watermark: true } }))
      .toMatchObject({ ok: true, request: { input: { enable_watermark: true } } });
    expect(buildWireRequest(model, { prompt: "x".repeat(301), refUrls: { image: [image], audio: [audio] } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("<=300 characters") });
    expect(buildWireRequest(model, { prompt: "x", refUrls: { image: [image] } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("requires at least 1 audio ref") });
  });

  it("exposes the Grok Imagine 1.5 preview frame controls with their upstream guards", () => {
    const model = resolveModel("kie:grok-imagine-video-1-5-preview");
    expect(model.title).toBe("Grok Imagine Video 1.5 Preview (Kie)");
    expect(model.slots.map((slot) => [slot.role, slot.field])).toEqual([
      ["first_frame", "first_frame_url"],
      ["last_frame", "last_frame_url"],
      ["image", "image_urls"],
    ]);
    expect(model.options.map((option) => option.name)).toEqual(expect.arrayContaining(["loop_url", "keyframes"]));
    const keyframes = [{ url: "https://example.com/k1.png", timestamp_s: 2 }, { url: "https://example.com/k2.png", timestamp_s: 4.5 }];
    expect(buildWireRequest(model, { prompt: "x", refUrls: { image: [image], first_frame: [first], last_frame: [last] }, options: { duration: 6, keyframes } }))
      .toMatchObject({ ok: true, request: { input: { image_urls: [image], first_frame_url: first, last_frame_url: last, keyframes, duration: 6 } } });
    expect(buildWireRequest(model, { prompt: "x", refUrls: { image: [image] }, options: { loop_url: first } }))
      .toMatchObject({ ok: true, request: { input: { loop_url: first } } });
    expect(buildWireRequest(model, { prompt: "x", refUrls: { first_frame: [first] } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("requires at least 1 image ref") });
    for (const [options, message] of [
      [{ duration: 6, keyframes: [{ url: image, timestamp_s: 6 }] }, "less than duration (6s)"],
      [{ keyframes: [{ url: image, timestamp_s: 2 }, { url: image, timestamp_s: 2.2 }] }, "at least 1/3 second apart"],
      [{ keyframes: [1, 2, 3, 4, 5].map((timestamp_s) => ({ url: image, timestamp_s })) }, "<=4 items"],
    ] as const) {
      expect(buildWireRequest(model, { prompt: "x", refUrls: { image: [image] }, options }))
        .toMatchObject({ ok: false, error: expect.stringContaining(message) });
    }
    expect(buildWireRequest(model, { prompt: "x", refUrls: { image: [image], first_frame: [first] }, options: { loop_url: last } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("loop_url cannot be combined with a different first_frame_url") });
    expect(applyPromptDialect(model.entry.dialect, "@firstframe becomes @image1", { first_frame: [A], image: [B] })).toBe("becomes reference image 1");
  });

  it("ranks only the Grok preview; Kling 4.0, PixVerse V6 Max and OmniHuman 2.0 are not on a frontier board", () => {
    expect(modelFrontierRankings("kie:grok-imagine-video-1-5-preview")).toEqual([expect.objectContaining({ type: "i2v", rank: 9, elo: 1067 })]);
    for (const apiId of ["kling-4.0/reference-to-video", "kling-4.0/keyframe-to-video", "pixverse-v6-max/text-to-video", "pixverse-v6-max/image-to-video", "omnihuman-2-0"]) {
      expect(modelFrontierRankings(`kie:${apiId}`), apiId).toEqual([]);
    }
  });

  it.each<[string, WireRequestInput, CostHints, number]>([
    ["kling-4.0/reference-to-video", { options: { duration: 10, resolution: "1080p" } }, {}, 10 * 0.2125],
    ["kling-4.0/reference-to-video", { refUrls: { video: [video] }, options: { duration: 5, resolution: "720p" } }, { inputDurationSeconds: 8 }, (5 + 8) * 0.085],
    ["kling-4.0/keyframe-to-video", { options: { duration: 10, resolution: "720p" } }, {}, 10 * 0.1425],
    ["pixverse-v6-max/text-to-video", { options: { duration: 5, quality: "720p" } }, {}, 5 * 0.044],
    ["pixverse-v6-max/image-to-video", { refUrls: { image: [image] }, options: { duration: 5, generate_audio_switch: true } }, {}, 5 * 0.112],
    ["omnihuman-2-0", { refUrls: { image: [image], audio: [audio] } }, { inputDurationSeconds: 6.008 }, 7 * 0.07],
    ["grok-imagine-video-1-5-preview", { refUrls: { image: [image] }, options: { resolution: "720p" } }, {}, 12 * 0.0225],
  ])("prices %s from the @apicity/cost rates", async (apiId, call, hints, usd) => {
    const result = await estimateGeneration(resolveModel(`kie:${apiId}`), { prompt: "A presenter waves", ...call }, hints);
    expect(result).toMatchObject({ ok: true, estimate: { warnings: [] } });
    if (result.ok) expect(result.estimate.usd).toBeCloseTo(usd);
  });

  it("asks for the reference video length before pricing Kling 4.0 video references", async () => {
    const result = await estimateGeneration(resolveModel("kie:kling-4.0/reference-to-video"), { prompt: "x", refUrls: { video: [video] } });
    expect(result).toMatchObject({ ok: true, estimate: { usd: 0, warnings: [expect.stringContaining("costHints.inputDurationSeconds")] } });
  });
});
